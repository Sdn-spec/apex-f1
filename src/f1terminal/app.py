"""The f1terminal Textual application."""

from __future__ import annotations

import datetime as dt
from typing import Any

from textual import work
from textual.app import App, ComposeResult
from textual.containers import Horizontal
from textual.css.query import NoMatches
from textual.widgets import Footer, TabbedContent, TabPane

from .data.jolpica import JolpicaClient, JolpicaError
from .data.openf1 import OpenF1Client, OpenF1Error
from .data.state import LiveClock, ReplayClock, SessionState, utcnow
from .ui.header import SessionHeader
from .ui.panels import DriverDetail, RaceControlLog, StrategyBoard
from .ui.stats import StatsBoard
from .ui.timing import TimingTower
from .ui.trackmap import TrackMap

# The map redraws far more often than the network is polled: car positions are
# interpolated between samples, so a fast render tick is what makes movement
# look continuous rather than jumping once per request.
MAP_TICK = 1 / 12
STATE_TICK = 0.5
LIVE_FETCH_TICK = 3.0
REPLAY_FETCH_TICK = 1.0


class F1Terminal(App[None]):
    CSS = """
    Screen { background: $surface; }
    SessionHeader { border-bottom: solid $primary-darken-2; }
    #race-split { height: 1fr; }
    #race-map { width: 55%; border-right: solid $primary-darken-3; }
    #race-timing { width: 45%; }
    TabbedContent { height: 1fr; }
    """

    BINDINGS = [
        ("q", "quit", "Quit"),
        ("1", "show_tab('race')", "Race"),
        ("2", "show_tab('timing')", "Timing"),
        ("3", "show_tab('strategy')", "Strategy"),
        ("4", "show_tab('driver')", "Driver"),
        ("5", "show_tab('stats')", "Stats"),
        ("6", "show_tab('control')", "Control"),
        ("up", "select(-1)", "Prev driver"),
        ("down", "select(1)", "Next driver"),
        ("space", "toggle_pause", "Pause"),
        ("left", "seek(-30)", "-30s"),
        ("right", "seek(30)", "+30s"),
        ("comma", "speed(0.5)", "Slower"),
        ("full_stop", "speed(2.0)", "Faster"),
        ("l", "toggle_labels", "Labels"),
        ("c", "toggle_corners", "Corners"),
        ("r", "force_refresh", "Refresh"),
    ]

    def __init__(
        self,
        session: dict[str, Any],
        *,
        live: bool,
        speed: float = 1.0,
        start_at: dt.datetime | None = None,
        client: OpenF1Client | None = None,
    ) -> None:
        super().__init__()
        self.openf1 = client or OpenF1Client()
        self.jolpica = JolpicaClient(cache=self.openf1.cache)
        self.session_info = session

        if live:
            clock = LiveClock()
        else:
            start = _parse(session.get("date_start")) or utcnow()
            end = _parse(session.get("date_end")) or (start + dt.timedelta(hours=2))
            clock = ReplayClock(start, end, speed=speed)
            if start_at is not None:
                clock._virtual = max(start, min(start_at, end))
        self.state = SessionState(self.openf1, session, clock)
        self._career_cache: dict[str, dict] = {}
        self._last_detail_driver: int | None = None

    # ---- layout ---------------------------------------------------------

    def compose(self) -> ComposeResult:
        yield SessionHeader(id="header")
        with TabbedContent(initial="race", id="tabs"):
            with TabPane("Race", id="race"):
                with Horizontal(id="race-split"):
                    yield TrackMap(id="race-map")
                    yield TimingTower(id="race-timing")
            with TabPane("Timing", id="timing"):
                yield TimingTower(detailed=True, id="detailed-timing")
            with TabPane("Strategy", id="strategy"):
                yield StrategyBoard(id="strategy-board")
            with TabPane("Driver", id="driver"):
                yield DriverDetail(id="driver-detail")
            with TabPane("Stats", id="stats"):
                yield StatsBoard(id="stats-board")
            with TabPane("Race Control", id="control"):
                yield RaceControlLog(id="control-log")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "f1terminal"
        self.sub_title = self.state.label
        self.set_interval(MAP_TICK, self._tick_map)
        self.set_interval(STATE_TICK, self._tick_state)
        self.set_interval(
            LIVE_FETCH_TICK if self.state.clock.is_live else REPLAY_FETCH_TICK,
            self._tick_fetch,
        )
        self.bootstrap()

    # ---- data flow ------------------------------------------------------

    @work(exclusive=True, group="bootstrap")
    async def bootstrap(self) -> None:
        try:
            await self.state.refresh()
            self.state.infer_total_laps()
        except OpenF1Error as exc:
            self.notify(f"Timing feed error: {exc}", severity="error", timeout=8)
        self._paint_all()
        self.load_history()
        self.load_geometry()

    @work(exclusive=True, group="geometry")
    async def load_geometry(self) -> None:
        try:
            geometry = await self.state.load_geometry()
        except OpenF1Error as exc:
            self.notify(f"Could not derive track outline: {exc}", severity="warning")
            return
        if geometry is None:
            self.notify("No lap telemetry available to derive the circuit outline.",
                        severity="warning")
        self._paint_all()

    @work(exclusive=True, group="history")
    async def load_history(self) -> None:
        board = self._find("#stats-board", StatsBoard)
        if board is None:
            return
        year = self.session_info.get("year")
        try:
            standings = await self.jolpica.driver_standings(year or "current")
            constructors = await self.jolpica.constructor_standings(year or "current")
        except JolpicaError as exc:
            board.update_data(status=f"championship data unavailable: {exc}")
            return
        board.update_data(drivers=standings, constructors=constructors)

        circuit_id = await self._resolve_circuit_id(year)
        if circuit_id:
            try:
                history = await self.jolpica.circuit_history(circuit_id)
            except JolpicaError:
                return
            board.update_data(history=history, circuit_name=self.state.circuit)

    async def _resolve_circuit_id(self, year: int | None) -> str | None:
        """Match OpenF1's circuit naming to a Jolpica circuitId via the calendar."""
        try:
            schedule = await self.jolpica.schedule(year or "current")
        except JolpicaError:
            return None
        location = (self.session_info.get("location") or "").lower()
        country = (self.session_info.get("country_name") or "").lower()
        short = (self.session_info.get("circuit_short_name") or "").lower()
        for race in schedule:
            circuit = race.get("Circuit", {})
            info = circuit.get("Location", {})
            haystack = " ".join(
                [
                    circuit.get("circuitName", ""),
                    circuit.get("circuitId", ""),
                    info.get("locality", ""),
                    info.get("country", ""),
                ]
            ).lower()
            if location and location in haystack:
                return circuit.get("circuitId")
            if short and short in haystack:
                return circuit.get("circuitId")
            if country and country in haystack:
                return circuit.get("circuitId")
        return None

    @work(exclusive=True, group="fetch")
    async def _tick_fetch(self) -> None:
        try:
            await self.state.refresh()
        except OpenF1Error:
            # Transient feed hiccup: the previous snapshot stays on screen.
            return

    def _tick_state(self) -> None:
        if not self._painting:
            return
        self.state.apply(self.state.clock.now())
        self._paint_all()

    def _tick_map(self) -> None:
        """Cheap tick: move the cars only, without reprojecting all timing."""
        if not self._painting:
            return
        self.state.update_car_positions(self.state.clock.now())
        track = self._find("#race-map", TrackMap)
        if track is not None:
            track.refresh()

    # ---- painting -------------------------------------------------------

    @property
    def _painting(self) -> bool:
        """Whether there is a widget tree to paint into.

        Timers start before the first mount and keep firing through teardown,
        so every tick has to tolerate the widgets not being there. Note this
        must not be called ``_ready``: Textual's own ``App._ready()`` is an
        internal coroutine, and shadowing it makes startup await a bool.
        """
        return self.state.static_loaded and self._find("#header", SessionHeader) is not None

    def _find(self, selector: str, kind: type) -> Any | None:
        try:
            return self.query_one(selector, kind)
        except NoMatches:
            return None

    def _paint_all(self) -> None:
        state = self.state
        for selector, kind in (
            ("#header", SessionHeader),
            ("#race-map", TrackMap),
            ("#race-timing", TimingTower),
            ("#detailed-timing", TimingTower),
            ("#strategy-board", StrategyBoard),
            ("#control-log", RaceControlLog),
        ):
            widget = self._find(selector, kind)
            if widget is not None:
                widget.update_state(state)
        self._paint_driver()

    def _paint_driver(self) -> None:
        tower = self._find("#race-timing", TimingTower)
        detail = self._find("#driver-detail", DriverDetail)
        if tower is None or detail is None:
            return
        driver = tower.selected_driver()
        if driver:
            track = self._find("#race-map", TrackMap)
            if track is not None:
                track.selected = driver.number
            career = self._career_cache.get(driver.full_name.lower())
            if career is None and driver.number != self._last_detail_driver:
                self._last_detail_driver = driver.number
                self.load_career(driver.full_name, driver.number)
        detail.update_state(self.state, driver, career)

    @work(exclusive=True, group="career")
    async def load_career(self, full_name: str, number: int) -> None:
        driver_id = await self._resolve_driver_id(full_name)
        if not driver_id:
            return
        try:
            career = await self.jolpica.driver_career(driver_id)
        except JolpicaError:
            return
        self._career_cache[full_name.lower()] = career
        tower = self._find("#race-timing", TimingTower)
        current = tower.selected_driver() if tower else None
        if current and current.number == number:
            self._paint_driver()

    async def _resolve_driver_id(self, full_name: str) -> str | None:
        surname = full_name.split()[-1].lower() if full_name else ""
        if not surname:
            return None
        try:
            standings = await self.jolpica.driver_standings(
                self.session_info.get("year") or "current"
            )
        except JolpicaError:
            return None
        for row in standings:
            driver = row.get("Driver", {})
            if driver.get("familyName", "").lower() == surname:
                return driver.get("driverId")
        return None

    # ---- actions --------------------------------------------------------

    def action_show_tab(self, tab: str) -> None:
        tabs = self._find("#tabs", TabbedContent)
        if tabs is not None:
            tabs.active = tab

    def action_select(self, delta: int) -> None:
        for widget_id in ("#race-timing", "#detailed-timing"):
            tower = self._find(widget_id, TimingTower)
            if tower is not None:
                tower.move_selection(delta)
        self._paint_driver()

    def action_toggle_pause(self) -> None:
        clock = self.state.clock
        if isinstance(clock, ReplayClock):
            paused = clock.toggle_pause()
            self.notify("Paused" if paused else "Resumed", timeout=1.5)
        else:
            self.notify("Live session — nothing to pause", timeout=2)

    def action_seek(self, seconds: float) -> None:
        clock = self.state.clock
        if isinstance(clock, ReplayClock):
            clock.seek(seconds)
            self._tick_fetch()
        else:
            self.notify("Seeking is only available in replay mode", timeout=2)

    def action_speed(self, factor: float) -> None:
        clock = self.state.clock
        if isinstance(clock, ReplayClock):
            clock.set_speed(clock.speed * factor)
            self.notify(f"Replay speed {clock.speed:g}x", timeout=1.5)

    def action_toggle_labels(self) -> None:
        track = self._find("#race-map", TrackMap)
        if track is not None:
            track.show_labels = not track.show_labels

    def action_toggle_corners(self) -> None:
        track = self._find("#race-map", TrackMap)
        if track is not None:
            track.show_corners = not track.show_corners

    def action_force_refresh(self) -> None:
        self._tick_fetch()
        self.notify("Refreshing…", timeout=1.5)

    async def on_unmount(self) -> None:
        await self.openf1.aclose()
        await self.jolpica.aclose()


def _parse(value: str | None) -> dt.datetime | None:
    from .data.openf1 import parse_dt

    return parse_dt(value)
