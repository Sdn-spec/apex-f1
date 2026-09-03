"""Domain types shared by the data layer and the UI."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any

COMPOUND_STYLE = {
    "SOFT": "bold red",
    "MEDIUM": "bold yellow",
    "HARD": "bold white",
    "INTERMEDIATE": "bold green",
    "WET": "bold blue",
    "TEST_UNKNOWN": "grey58",
    "UNKNOWN": "grey58",
}

COMPOUND_SHORT = {
    "SOFT": "S",
    "MEDIUM": "M",
    "HARD": "H",
    "INTERMEDIATE": "I",
    "WET": "W",
}

FALLBACK_TEAM_COLOUR = "9E9E9E"


class TrackStatus:
    GREEN = "GREEN"
    YELLOW = "YELLOW"
    DOUBLE_YELLOW = "DOUBLE YELLOW"
    SAFETY_CAR = "SAFETY CAR"
    VSC = "VIRTUAL SC"
    RED = "RED FLAG"
    CHEQUERED = "CHEQUERED"
    UNKNOWN = "—"


TRACK_STATUS_STYLE = {
    TrackStatus.GREEN: "bold black on green",
    TrackStatus.YELLOW: "bold black on yellow",
    TrackStatus.DOUBLE_YELLOW: "bold black on yellow",
    TrackStatus.SAFETY_CAR: "bold black on orange1",
    TrackStatus.VSC: "bold black on orange1",
    TrackStatus.RED: "bold white on red",
    TrackStatus.CHEQUERED: "bold black on white",
    TrackStatus.UNKNOWN: "grey58",
}


def format_lap_time(seconds: float | None) -> str:
    """Render a lap time the way a timing screen does: 1:23.456."""
    if seconds is None:
        return "—"
    if seconds < 0:
        return "—"
    minutes, rest = divmod(seconds, 60.0)
    if minutes:
        return f"{int(minutes)}:{rest:06.3f}"
    return f"{rest:.3f}"


def format_gap(value: float | str | None, *, leader: bool = False) -> str:
    if leader:
        return "LEADER"
    if value is None:
        return "—"
    if isinstance(value, str):
        # OpenF1 uses strings such as "1 L" for lapped runners.
        return value.replace("LAP", "L").strip()
    if value == 0:
        return "—"
    return f"+{value:.3f}"


def format_sector(seconds: float | None) -> str:
    return "—" if seconds is None else f"{seconds:.3f}"


@dataclass
class Stint:
    stint_number: int
    compound: str
    lap_start: int
    lap_end: int
    tyre_age_at_start: int

    @property
    def laps(self) -> int:
        return max(self.lap_end - self.lap_start + 1, 0)

    def age_at(self, lap: int) -> int:
        return self.tyre_age_at_start + max(lap - self.lap_start, 0)


@dataclass
class PitStop:
    lap_number: int
    date: dt.datetime | None
    duration: float | None


@dataclass
class LapRecord:
    lap_number: int
    date_start: dt.datetime | None
    duration: float | None
    sector_1: float | None
    sector_2: float | None
    sector_3: float | None
    i1_speed: int | None = None
    i2_speed: int | None = None
    st_speed: int | None = None
    is_pit_out_lap: bool = False
    segments_sector_1: list[int] = field(default_factory=list)
    segments_sector_2: list[int] = field(default_factory=list)
    segments_sector_3: list[int] = field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        return bool(self.duration and 0 < self.duration < 600 and not self.is_pit_out_lap)


@dataclass
class Driver:
    number: int
    acronym: str
    full_name: str
    team: str
    colour: str = FALLBACK_TEAM_COLOUR

    # live timing
    position: int | None = None
    gap_to_leader: float | str | None = None
    interval: float | None = None
    lap_number: int = 0
    last_lap: LapRecord | None = None
    best_lap: float | None = None
    best_sectors: list[float | None] = field(default_factory=lambda: [None, None, None])

    # strategy
    stints: list[Stint] = field(default_factory=list)
    pit_stops: list[PitStop] = field(default_factory=list)
    in_pit: bool = False

    # telemetry / geometry
    x: float | None = None
    y: float | None = None
    speed: int | None = None
    throttle: int | None = None
    brake: int | None = None
    drs: int | None = None
    gear: int | None = None
    rpm: int | None = None

    retired: bool = False
    last_seen: dt.datetime | None = None

    @property
    def style(self) -> str:
        return f"#{self.colour}"

    @property
    def current_stint(self) -> Stint | None:
        return self.stints[-1] if self.stints else None

    @property
    def compound(self) -> str | None:
        stint = self.current_stint
        return stint.compound if stint else None

    @property
    def tyre_age(self) -> int | None:
        stint = self.current_stint
        if stint is None:
            return None
        return stint.age_at(self.lap_number)

    @property
    def stop_count(self) -> int:
        return len(self.pit_stops)

    @property
    def status_label(self) -> str:
        if self.retired:
            return "OUT"
        if self.in_pit:
            return "PIT"
        return "  "

    @property
    def drs_active(self) -> bool:
        # OpenF1 DRS codes: 10/12/14 mean the flap is open.
        return self.drs in (10, 12, 14)


@dataclass
class RaceControlMessage:
    date: dt.datetime | None
    category: str
    message: str
    flag: str | None = None
    scope: str | None = None
    sector: int | None = None
    driver_number: int | None = None

    @property
    def style(self) -> str:
        flag = (self.flag or "").upper()
        if flag in ("RED",):
            return "bold red"
        if flag in ("YELLOW", "DOUBLE YELLOW"):
            return "yellow"
        if flag == "GREEN":
            return "green"
        if flag == "CHEQUERED":
            return "bold white"
        if self.category == "SafetyCar":
            return "orange1"
        if self.category == "Drs":
            return "cyan"
        return "grey70"


@dataclass
class Weather:
    date: dt.datetime | None = None
    air_temperature: float | None = None
    track_temperature: float | None = None
    humidity: float | None = None
    pressure: float | None = None
    wind_speed: float | None = None
    wind_direction: int | None = None
    rainfall: int | None = None

    @property
    def is_wet(self) -> bool:
        return bool(self.rainfall)

    def summary(self) -> str:
        parts = []
        if self.air_temperature is not None:
            parts.append(f"Air {self.air_temperature:.1f}°C")
        if self.track_temperature is not None:
            parts.append(f"Track {self.track_temperature:.1f}°C")
        if self.humidity is not None:
            parts.append(f"Hum {self.humidity:.0f}%")
        if self.wind_speed is not None:
            parts.append(f"Wind {self.wind_speed:.1f}m/s")
        parts.append("RAIN" if self.is_wet else "Dry")
        return "  ".join(parts)


def wind_arrow(direction: int | None) -> str:
    if direction is None:
        return ""
    arrows = "↑↗→↘↓↙←↖"
    return arrows[int(((direction % 360) + 22.5) // 45) % 8]


def driver_from_api(row: dict[str, Any]) -> Driver:
    colour = (row.get("team_colour") or FALLBACK_TEAM_COLOUR).lstrip("#")
    if len(colour) != 6:
        colour = FALLBACK_TEAM_COLOUR
    number = int(row.get("driver_number") or 0)
    acronym = row.get("name_acronym") or str(number)
    return Driver(
        number=number,
        acronym=acronym,
        full_name=row.get("full_name") or row.get("broadcast_name") or acronym,
        team=row.get("team_name") or "—",
        colour=colour,
    )
