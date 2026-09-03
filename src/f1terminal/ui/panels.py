"""Secondary panels: tyre strategy, race control log and per-driver detail."""

from __future__ import annotations

from rich.box import SIMPLE_HEAD
from rich.console import Group, RenderableType
from rich.table import Table
from rich.text import Text
from textual.widget import Widget

from ..data.models import (
    COMPOUND_SHORT,
    COMPOUND_STYLE,
    Driver,
    format_lap_time,
)
from ..data.state import SessionState

COMPOUND_FILL = {
    "SOFT": "red",
    "MEDIUM": "yellow",
    "HARD": "grey85",
    "INTERMEDIATE": "green",
    "WET": "blue",
}


class StrategyBoard(Widget):
    """One row per driver showing tyre stints laid out across race distance."""

    DEFAULT_CSS = """
    StrategyBoard { height: 1fr; padding: 0 1; }
    """

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self.state: SessionState | None = None

    def update_state(self, state: SessionState) -> None:
        self.state = state
        self.refresh()

    def render(self) -> RenderableType:
        state = self.state
        if state is None:
            return Text("waiting for strategy data…", style="grey50")

        total = state.total_laps or max(state.leader_lap, 1)
        bar_width = max(self.size.width - 30, 20)

        table = Table(
            box=SIMPLE_HEAD,
            expand=True,
            pad_edge=False,
            padding=(0, 1),
            header_style="grey42",
            show_edge=False,
        )
        table.add_column("P", justify="right", width=2)
        table.add_column("DRV", width=4)
        table.add_column(f"STINTS  (lap 1 → {total})", justify="left", ratio=1)
        table.add_column("STOPS", justify="right", width=5)

        for driver in state.classification():
            table.add_row(
                Text(str(driver.position or "-"), style="bold"),
                Text(driver.acronym, style=f"bold {driver.style}"),
                self._stint_bar(driver, total, bar_width),
                Text(str(driver.stop_count), style="grey70"),
            )
        return table

    def _stint_bar(self, driver: Driver, total_laps: int, width: int) -> Text:
        bar = Text()
        if not driver.stints:
            bar.append("no stint data", style="grey30")
            return bar

        for stint in driver.stints:
            end = stint.lap_end or driver.lap_number or stint.lap_start
            laps = max(end - stint.lap_start + 1, 1)
            cells = max(round(laps / total_laps * width), 1)
            fill = COMPOUND_FILL.get(stint.compound, "grey50")
            short = COMPOUND_SHORT.get(stint.compound, "?")
            # Write the compound letter into the block when it fits.
            if cells >= 3:
                body = short + "─" * (cells - 2) + "│"
            else:
                body = short * cells
            bar.append(body, style=f"bold {fill}")
        return bar


class RaceControlLog(Widget):
    """Race control messages, newest first."""

    DEFAULT_CSS = """
    RaceControlLog { height: 1fr; padding: 0 1; }
    """

    def __init__(self, limit: int = 200, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self.state: SessionState | None = None
        self.limit = limit

    def update_state(self, state: SessionState) -> None:
        self.state = state
        self.refresh()

    def render(self) -> RenderableType:
        state = self.state
        if state is None:
            return Text("waiting for race control…", style="grey50")
        messages = state.recent_messages(self.limit)
        if not messages:
            return Text("no messages yet", style="grey42")

        table = Table.grid(expand=True, padding=(0, 1))
        table.add_column(width=8, justify="left")
        table.add_column(width=10, justify="left")
        table.add_column(ratio=1, justify="left", overflow="fold")
        for message in messages:
            stamp = message.date.strftime("%H:%M:%S") if message.date else "—"
            table.add_row(
                Text(stamp, style="grey42"),
                Text(message.category[:10], style="grey54"),
                Text(message.message, style=message.style),
            )
        return table


class DriverDetail(Widget):
    """Everything known about one driver: telemetry, stints, stops, history."""

    DEFAULT_CSS = """
    DriverDetail { height: 1fr; padding: 0 1; }
    """

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self.state: SessionState | None = None
        self.driver: Driver | None = None
        self.career: dict | None = None

    def update_state(
        self, state: SessionState, driver: Driver | None, career: dict | None = None
    ) -> None:
        self.state = state
        self.driver = driver
        self.career = career
        self.refresh()

    def render(self) -> RenderableType:
        driver = self.driver
        state = self.state
        if driver is None or state is None:
            return Text("select a driver with ↑/↓", style="grey42")

        title = Text()
        title.append(f"#{driver.number} ", style="grey54")
        title.append(driver.full_name, style=f"bold {driver.style}")
        title.append(f"   {driver.team}", style="grey62")

        summary = Table.grid(expand=True, padding=(0, 2))
        summary.add_column(justify="left", ratio=1)
        summary.add_column(justify="left", ratio=1)
        summary.add_column(justify="left", ratio=1)

        record = driver.last_lap
        summary.add_row(
            self._pair("Position", str(driver.position or "—")),
            self._pair("Lap", str(driver.lap_number or "—")),
            self._pair("Stops", str(driver.stop_count)),
        )
        summary.add_row(
            self._pair("Last lap", format_lap_time(record.duration if record else None)),
            self._pair("Best lap", format_lap_time(driver.best_lap)),
            self._pair(
                "Tyre",
                f"{driver.compound or '—'} ({driver.tyre_age if driver.tyre_age is not None else '—'} laps)",
                style=COMPOUND_STYLE.get(driver.compound or "", "white"),
            ),
        )
        if record:
            summary.add_row(
                self._pair("Sector 1", _fmt(record.sector_1)),
                self._pair("Sector 2", _fmt(record.sector_2)),
                self._pair("Sector 3", _fmt(record.sector_3)),
            )
            summary.add_row(
                self._pair("Speed trap", f"{record.st_speed} km/h" if record.st_speed else "—"),
                self._pair("I1 speed", f"{record.i1_speed} km/h" if record.i1_speed else "—"),
                self._pair("I2 speed", f"{record.i2_speed} km/h" if record.i2_speed else "—"),
            )

        blocks: list[RenderableType] = [title, Text(), summary]

        if driver.stints:
            stints = Table(box=SIMPLE_HEAD, expand=False, header_style="grey42", show_edge=False)
            stints.add_column("Stint", justify="right")
            stints.add_column("Tyre")
            stints.add_column("Laps", justify="right")
            stints.add_column("Age at start", justify="right")
            for stint in driver.stints:
                stints.add_row(
                    str(stint.stint_number),
                    Text(stint.compound, style=COMPOUND_STYLE.get(stint.compound, "white")),
                    f"{stint.lap_start}–{stint.lap_end or '…'}",
                    str(stint.tyre_age_at_start),
                )
            blocks += [Text(), Text("STINTS", style="grey42"), stints]

        if driver.pit_stops:
            stops = Table(box=SIMPLE_HEAD, expand=False, header_style="grey42", show_edge=False)
            stops.add_column("Lap", justify="right")
            stops.add_column("Time of day")
            stops.add_column("Pit lane", justify="right")
            for stop in driver.pit_stops:
                stops.add_row(
                    str(stop.lap_number),
                    stop.date.strftime("%H:%M:%S") if stop.date else "—",
                    _pit_duration(stop.duration),
                )
            blocks += [Text(), Text("PIT STOPS", style="grey42"), stops]

        if self.career:
            career = Table.grid(expand=True, padding=(0, 2))
            for _ in range(4):
                career.add_column(justify="left", ratio=1)
            data = self.career
            career.add_row(
                self._pair("Starts", str(data.get("starts", "—"))),
                self._pair("Wins", str(data.get("wins", "—"))),
                self._pair("Podiums", str(data.get("podiums", "—"))),
                self._pair("Career points", str(data.get("points", "—"))),
            )
            career.add_row(
                self._pair("Best finish", str(data.get("best_finish") or "—")),
                self._pair("Seasons", str(data.get("seasons", "—"))),
                self._pair("First season", str(data.get("first_season") or "—")),
                self._pair("Retirements", str(data.get("dnfs", "—"))),
            )
            blocks += [Text(), Text("CAREER", style="grey42"), career]

        return Group(*blocks)

    @staticmethod
    def _pair(label: str, value: str, style: str = "white") -> Text:
        text = Text()
        text.append(f"{label:<14}", style="grey42")
        text.append(value, style=style)
        return text


def _fmt(value: float | None) -> str:
    return "—" if value is None else f"{value:.3f}"


def _pit_duration(seconds: float | None) -> str:
    """Stops served under a red flag last minutes, not seconds."""
    if seconds is None:
        return "—"
    if seconds >= 120:
        return f"{int(seconds // 60)}m{int(seconds % 60):02d}s"
    return f"{seconds:.1f}s"
