"""Session header: what race this is, what the track is doing, and the clock."""

from __future__ import annotations

from rich.console import Group, RenderableType
from rich.table import Table
from rich.text import Text
from textual.widget import Widget

from ..data.models import TRACK_STATUS_STYLE, format_lap_time, wind_arrow
from ..data.state import ReplayClock, SessionState


class SessionHeader(Widget):
    DEFAULT_CSS = """
    SessionHeader {
        height: 4;
        padding: 0 1;
        background: $panel;
    }
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
            return Text("f1terminal — connecting…", style="bold")

        top = Table.grid(expand=True)
        top.add_column(justify="left", ratio=3)
        top.add_column(justify="center", ratio=2)
        top.add_column(justify="right", ratio=3)

        title = Text()
        title.append(f"{state.label}", style="bold white")
        title.append(f"  ·  {state.circuit}", style="grey62")
        if state.geometry:
            title.append(f"  ·  {state.geometry.length / 1000:.3f} km", style="grey42")

        status = Text(
            f" {state.track_status} ",
            style=TRACK_STATUS_STYLE.get(state.track_status, "grey58"),
        )

        laps = Text()
        if state.total_laps:
            laps.append(f"LAP {state.leader_lap}/{state.total_laps}", style="bold")
            remaining = state.laps_remaining()
            if remaining is not None:
                laps.append(f"  ({remaining} to go)", style="grey54")
        else:
            laps.append(f"LAP {state.leader_lap}", style="bold")
        top.add_row(title, status, laps)

        bottom = Table.grid(expand=True)
        bottom.add_column(justify="left", ratio=3)
        bottom.add_column(justify="center", ratio=2)
        bottom.add_column(justify="right", ratio=3)

        weather = Text()
        wx = state.weather
        weather.append("WX ", style="grey42")
        weather.append(wx.summary(), style="cyan" if wx.is_wet else "grey70")
        arrow = wind_arrow(wx.wind_direction)
        if arrow:
            weather.append(f" {arrow}", style="grey54")

        fastest = Text()
        if state.fastest_lap:
            number, seconds = state.fastest_lap
            driver = state.drivers.get(number)
            fastest.append("FASTEST ", style="grey42")
            fastest.append(
                f"{driver.acronym if driver else number} {format_lap_time(seconds)}",
                style="bold magenta",
            )

        bottom.add_row(weather, fastest, self._clock_text(state))
        return Group(top, bottom)

    def _clock_text(self, state: SessionState) -> Text:
        clock = state.clock
        text = Text()
        if isinstance(clock, ReplayClock):
            filled = int(clock.progress * 18)
            text.append("REPLAY ", style="bold yellow")
            text.append("▐" + "█" * filled + "░" * (18 - filled) + "▌", style="yellow")
            text.append(f" {clock.speed:g}x", style="grey70")
            if clock.paused:
                text.append("  PAUSED", style="bold red")
            text.append(f"  {clock.now():%H:%M:%S}", style="grey54")
        else:
            text.append("● LIVE", style="bold red")
            text.append(f"  {clock.now():%H:%M:%S} UTC", style="grey70")
        return text
