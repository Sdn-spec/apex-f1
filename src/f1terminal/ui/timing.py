"""The timing tower — the live classification, with sector and tyre detail."""

from __future__ import annotations

from rich.box import SIMPLE_HEAD
from rich.console import RenderableType
from rich.table import Table
from rich.text import Text
from textual.reactive import reactive
from textual.widget import Widget

from ..data.models import (
    COMPOUND_SHORT,
    COMPOUND_STYLE,
    Driver,
    format_gap,
    format_lap_time,
    format_sector,
)
from ..data.state import SessionState

SESSION_BEST = "bold magenta"
PERSONAL_BEST = "bold green"
NORMAL_TIME = "yellow"
EPSILON = 1e-4


class TimingTower(Widget):
    """Classification table.

    ``detailed`` adds sector times, speed traps and stop counts; the compact
    form is what sits beside the track map.
    """

    DEFAULT_CSS = """
    TimingTower {
        height: 1fr;
        padding: 0 1;
    }
    """

    selected_index: reactive[int] = reactive(0)

    def __init__(self, detailed: bool = False, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self.state: SessionState | None = None
        self.detailed = detailed

    def update_state(self, state: SessionState) -> None:
        self.state = state
        self.refresh()

    @property
    def order(self) -> list[Driver]:
        return self.state.classification() if self.state else []

    def selected_driver(self) -> Driver | None:
        order = self.order
        if not order:
            return None
        return order[max(0, min(self.selected_index, len(order) - 1))]

    def move_selection(self, delta: int) -> None:
        order = self.order
        if not order:
            return
        self.selected_index = max(0, min(self.selected_index + delta, len(order) - 1))
        self.refresh()

    def render(self) -> RenderableType:
        state = self.state
        if state is None:
            return Text("waiting for timing…", style="grey50")

        table = Table(
            box=SIMPLE_HEAD,
            expand=True,
            pad_edge=False,
            padding=(0, 1),
            header_style="grey42",
            show_edge=False,
        )
        table.add_column("P", justify="right", width=2)
        table.add_column("DRV", justify="left", width=4)
        if self.detailed:
            table.add_column("TEAM", justify="left", width=14, overflow="ellipsis")
        table.add_column("GAP", justify="right", width=8)
        table.add_column("INT", justify="right", width=8)
        table.add_column("LAST", justify="right", width=9)
        if self.detailed:
            table.add_column("BEST", justify="right", width=9)
            table.add_column("S1", justify="right", width=7)
            table.add_column("S2", justify="right", width=7)
            table.add_column("S3", justify="right", width=7)
            table.add_column("ST", justify="right", width=4)
        table.add_column("TYRE", justify="left", width=6)
        table.add_column("PIT", justify="right", width=3)

        order = self.order
        for index, driver in enumerate(order):
            table.add_row(*self._row(state, driver, index), style=self._row_style(index))
        return table

    def _row_style(self, index: int) -> str:
        return "on grey19" if index == self.selected_index else ""

    def _row(self, state: SessionState, driver: Driver, index: int) -> list[Text]:
        position = Text(str(driver.position or "-"), style="bold")
        name = Text(driver.acronym, style=f"bold {driver.style}")
        if driver.retired:
            name.stylize("strike dim")

        leader = driver.position == 1
        gap = Text(format_gap(driver.gap_to_leader, leader=leader), style="grey74")
        interval = Text(format_gap(driver.interval), style="white")
        if driver.retired:
            gap = Text("OUT", style="red")
            interval = Text("—", style="grey30")
        elif driver.in_pit:
            interval = Text("IN PIT", style="bold cyan")

        last = self._lap_text(state, driver)
        cells: list[Text] = [position, name]
        if self.detailed:
            cells.append(Text(driver.team, style="grey62"))
        cells += [gap, interval, last]

        if self.detailed:
            cells.append(
                Text(
                    format_lap_time(driver.best_lap),
                    style=self._best_lap_style(state, driver),
                )
            )
            record = driver.last_lap
            sectors = (
                (record.sector_1, record.sector_2, record.sector_3)
                if record
                else (None, None, None)
            )
            for sector_index, value in enumerate(sectors):
                cells.append(self._sector_text(state, driver, sector_index, value))
            speed = record.st_speed if record else None
            cells.append(Text(str(speed) if speed else "—", style="grey62"))

        cells.append(self._tyre_text(driver))
        cells.append(Text(str(driver.stop_count or "—"), style="grey62"))
        return cells

    def _lap_text(self, state: SessionState, driver: Driver) -> Text:
        record = driver.last_lap
        if record is None or record.duration is None:
            return Text("—", style="grey30")
        style = NORMAL_TIME
        if state.fastest_lap and state.fastest_lap[0] == driver.number:
            if abs(record.duration - state.fastest_lap[1]) < EPSILON:
                style = SESSION_BEST
        elif driver.best_lap is not None and abs(record.duration - driver.best_lap) < EPSILON:
            style = PERSONAL_BEST
        return Text(format_lap_time(record.duration), style=style)

    def _best_lap_style(self, state: SessionState, driver: Driver) -> str:
        if driver.best_lap is None:
            return "grey30"
        if state.fastest_lap and state.fastest_lap[0] == driver.number:
            return SESSION_BEST
        return "grey74"

    def _sector_text(
        self, state: SessionState, driver: Driver, index: int, value: float | None
    ) -> Text:
        if value is None:
            return Text("—", style="grey30")
        style = NORMAL_TIME
        overall = state.best_sectors[index]
        personal = driver.best_sectors[index]
        if overall and abs(value - overall[1]) < EPSILON:
            style = SESSION_BEST
        elif personal is not None and abs(value - personal) < EPSILON:
            style = PERSONAL_BEST
        return Text(format_sector(value), style=style)

    def _tyre_text(self, driver: Driver) -> Text:
        compound = driver.compound
        if not compound:
            return Text("—", style="grey30")
        text = Text()
        text.append(
            COMPOUND_SHORT.get(compound, compound[:1]),
            style=COMPOUND_STYLE.get(compound, "grey58"),
        )
        age = driver.tyre_age
        if age is not None:
            text.append(f" {age:>2}", style="grey54")
        return text
