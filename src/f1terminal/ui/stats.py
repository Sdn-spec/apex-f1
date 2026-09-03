"""Championship and circuit history, for context around the live session."""

from __future__ import annotations

from typing import Any

from rich.box import SIMPLE_HEAD
from rich.console import Group, RenderableType
from rich.table import Table
from rich.text import Text
from textual.widget import Widget


class StatsBoard(Widget):
    """Driver and constructor standings plus past winners at this circuit."""

    DEFAULT_CSS = """
    StatsBoard { height: 1fr; padding: 0 1; }
    """

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self.drivers: list[dict[str, Any]] = []
        self.constructors: list[dict[str, Any]] = []
        self.history: list[dict[str, Any]] = []
        self.circuit_name: str = ""
        self.status: str = "loading championship data…"

    def update_data(
        self,
        *,
        drivers: list[dict[str, Any]] | None = None,
        constructors: list[dict[str, Any]] | None = None,
        history: list[dict[str, Any]] | None = None,
        circuit_name: str | None = None,
        status: str | None = None,
    ) -> None:
        if drivers is not None:
            self.drivers = drivers
        if constructors is not None:
            self.constructors = constructors
        if history is not None:
            self.history = history
        if circuit_name is not None:
            self.circuit_name = circuit_name
        if status is not None:
            self.status = status
        self.refresh()

    def render(self) -> RenderableType:
        if not (self.drivers or self.constructors or self.history):
            return Text(self.status, style="grey50")

        columns = Table.grid(expand=True, padding=(0, 2))
        columns.add_column(ratio=3)
        columns.add_column(ratio=2)
        columns.add_row(self._driver_table(), self._constructor_table())

        blocks: list[RenderableType] = [
            Text("WORLD CHAMPIONSHIP", style="grey42"),
            columns,
        ]
        if self.history:
            blocks += [
                Text(),
                Text(f"PAST WINNERS — {self.circuit_name.upper()}", style="grey42"),
                self._history_table(),
            ]
        return Group(*blocks)

    def _driver_table(self) -> RenderableType:
        if not self.drivers:
            return Text("—", style="grey30")
        table = Table(box=SIMPLE_HEAD, expand=True, header_style="grey42", show_edge=False)
        table.add_column("P", justify="right", width=2)
        table.add_column("Driver", ratio=2)
        table.add_column("Team", ratio=2, overflow="ellipsis")
        table.add_column("Pts", justify="right", width=5)
        table.add_column("Wins", justify="right", width=4)
        for row in self.drivers[:12]:
            driver = row.get("Driver", {})
            teams = row.get("Constructors", [])
            table.add_row(
                Text(row.get("position", "—"), style="bold"),
                Text(
                    f"{driver.get('givenName', '')[:1]}. {driver.get('familyName', '')}",
                    style="white",
                ),
                Text(teams[0].get("name", "—") if teams else "—", style="grey62"),
                Text(row.get("points", "0"), style="bold yellow"),
                Text(row.get("wins", "0"), style="grey70"),
            )
        return table

    def _constructor_table(self) -> RenderableType:
        if not self.constructors:
            return Text("—", style="grey30")
        table = Table(box=SIMPLE_HEAD, expand=True, header_style="grey42", show_edge=False)
        table.add_column("P", justify="right", width=2)
        table.add_column("Constructor", ratio=1, overflow="ellipsis")
        table.add_column("Pts", justify="right", width=5)
        for row in self.constructors[:10]:
            team = row.get("Constructor", {})
            table.add_row(
                Text(row.get("position", "—"), style="bold"),
                Text(team.get("name", "—"), style="white"),
                Text(row.get("points", "0"), style="bold yellow"),
            )
        return table

    def _history_table(self) -> RenderableType:
        table = Table(box=SIMPLE_HEAD, expand=True, header_style="grey42", show_edge=False)
        table.add_column("Year", justify="right", width=5)
        table.add_column("Winner", ratio=2)
        table.add_column("Team", ratio=2, overflow="ellipsis")
        table.add_column("Time", justify="right", ratio=1)
        for race in self.history[:12]:
            results = race.get("Results", [])
            if not results:
                continue
            entry = results[0]
            driver = entry.get("Driver", {})
            team = entry.get("Constructor", {})
            time = entry.get("Time", {}).get("time", "—")
            table.add_row(
                Text(race.get("season", "—"), style="grey70"),
                Text(
                    f"{driver.get('givenName', '')[:1]}. {driver.get('familyName', '')}",
                    style="white",
                ),
                Text(team.get("name", "—"), style="grey62"),
                Text(time, style="grey62"),
            )
        return table
