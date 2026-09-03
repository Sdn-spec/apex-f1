"""Session state: turns OpenF1's flat record feeds into a live race picture.

Everything the UI renders comes from one :class:`SessionState`. It is driven by
a clock, which is the only difference between watching a live race and
replaying a finished one — live mode advances with the wall clock and polls for
new records, replay mode advances a virtual clock and slices records that were
downloaded up front. Both then run the same projection: for each driver take
the newest record at or before "now" and fold it into a :class:`Driver`.
"""

from __future__ import annotations

import asyncio
import bisect
import datetime as dt
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from ..track import TrackGeometry
from .models import (
    Driver,
    LapRecord,
    PitStop,
    RaceControlMessage,
    Stint,
    TrackStatus,
    Weather,
    driver_from_api,
)
from .openf1 import OpenF1Client, OpenF1Error, parse_dt

UTC = dt.timezone.utc

# Longest a pit record's window is trusted to mean "car is in the pit lane".
# Red-flag stops report durations of many minutes, which would otherwise pin a
# driver to PIT for the rest of the race.
MAX_PIT_WINDOW = 90.0

# How long a car's timing feed must go quiet before it counts as retired. Long
# enough to survive a slow lap or a red-flag queue, short enough to catch a car
# that has actually stopped.
RETIREMENT_SILENCE = 210.0


def utcnow() -> dt.datetime:
    return dt.datetime.now(UTC)


class Clock:
    def now(self) -> dt.datetime:
        raise NotImplementedError

    @property
    def is_live(self) -> bool:
        return False


class LiveClock(Clock):
    def now(self) -> dt.datetime:
        return utcnow()

    @property
    def is_live(self) -> bool:
        return True


class ReplayClock(Clock):
    """A virtual clock over a finished session, with pause and seek."""

    def __init__(self, start: dt.datetime, end: dt.datetime, speed: float = 1.0) -> None:
        self.start = start
        self.end = end
        self.speed = speed
        self._virtual = start
        self._anchor = utcnow()
        self.paused = False

    def now(self) -> dt.datetime:
        if not self.paused:
            real_elapsed = (utcnow() - self._anchor).total_seconds()
            self._virtual = self._virtual + dt.timedelta(seconds=real_elapsed * self.speed)
            self._anchor = utcnow()
            if self._virtual > self.end:
                self._virtual = self.end
                self.paused = True
        return self._virtual

    def toggle_pause(self) -> bool:
        self.now()
        self.paused = not self.paused
        self._anchor = utcnow()
        return self.paused

    def set_speed(self, speed: float) -> None:
        self.now()
        self.speed = max(0.25, min(speed, 60.0))

    def seek(self, seconds: float) -> None:
        self.now()
        target = self._virtual + dt.timedelta(seconds=seconds)
        self._virtual = max(self.start, min(target, self.end))
        self._anchor = utcnow()

    def seek_fraction(self, fraction: float) -> None:
        span = (self.end - self.start).total_seconds()
        self._virtual = self.start + dt.timedelta(seconds=span * max(0.0, min(fraction, 1.0)))
        self._anchor = utcnow()

    @property
    def progress(self) -> float:
        span = (self.end - self.start).total_seconds()
        if span <= 0:
            return 1.0
        return max(0.0, min((self._virtual - self.start).total_seconds() / span, 1.0))


@dataclass
class TimedSeries:
    """Records sorted by timestamp, queried by 'newest at or before now'."""

    dates: list[dt.datetime] = field(default_factory=list)
    rows: list[dict[str, Any]] = field(default_factory=list)
    _seen: set[tuple[dt.datetime, int]] = field(default_factory=set, repr=False)

    def extend(self, records: Iterable[dict[str, Any]], key: str = "date") -> None:
        fresh: list[tuple[dt.datetime, dict[str, Any]]] = []
        for row in records:
            when = parse_dt(row.get(key))
            if when is None:
                continue
            # OpenF1's comparison filter is inclusive, so each poll re-sends the
            # record on the cursor boundary.
            token = (when, int(row.get("driver_number") or 0))
            if token in self._seen:
                continue
            self._seen.add(token)
            fresh.append((when, row))
        if not fresh:
            return
        fresh.sort(key=lambda item: item[0])
        if self.dates and fresh[0][0] < self.dates[-1]:
            for when, row in fresh:
                index = bisect.bisect_right(self.dates, when)
                self.dates.insert(index, when)
                self.rows.insert(index, row)
        else:
            self.dates.extend(when for when, _ in fresh)
            self.rows.extend(row for _, row in fresh)

    def upto(self, now: dt.datetime) -> list[dict[str, Any]]:
        cut = bisect.bisect_right(self.dates, now)
        return self.rows[:cut]

    def latest_per_driver(
        self, now: dt.datetime
    ) -> dict[int, tuple[dt.datetime, dict[str, Any]]]:
        """Newest record per car at or before ``now``, with its timestamp."""
        cut = bisect.bisect_right(self.dates, now)
        latest: dict[int, tuple[dt.datetime, dict[str, Any]]] = {}
        for index in range(cut):
            number = self.rows[index].get("driver_number")
            if number is not None:
                latest[int(number)] = (self.dates[index], self.rows[index])
        return latest

    def latest(self, now: dt.datetime) -> dict[str, Any] | None:
        cut = bisect.bisect_right(self.dates, now)
        return self.rows[cut - 1] if cut else None

    @property
    def newest_date(self) -> dt.datetime | None:
        return self.dates[-1] if self.dates else None


class LocationBuffer:
    """Windowed cache of car coordinates, with interpolation between samples.

    The location feed is by far the largest endpoint — around 3.7 samples per
    second per car — so it is never fetched for a whole session. Instead a
    sliding window is kept around the current clock position and refilled just
    before it runs out.
    """

    def __init__(self, client: OpenF1Client, session_key: int, window: float = 60.0) -> None:
        self.client = client
        self.session_key = session_key
        self.window = window
        self.samples: dict[int, tuple[list[dt.datetime], list[tuple[float, float]]]] = {}
        self.covered_to: dt.datetime | None = None
        self._fetching = False
        self.error: str | None = None

    async def ensure(self, now: dt.datetime, *, live: bool) -> None:
        if self._fetching:
            return
        margin = dt.timedelta(seconds=self.window * 0.35)
        if self.covered_to is not None and now + margin < self.covered_to:
            return

        start = self.covered_to or (now - dt.timedelta(seconds=5))
        if now - start > dt.timedelta(seconds=self.window * 3):
            # A large seek: discard and refill around the new position.
            self.samples.clear()
            start = now - dt.timedelta(seconds=5)
        end = now + dt.timedelta(seconds=self.window)
        if live:
            end = min(end, utcnow())
        if end <= start:
            return

        self._fetching = True
        try:
            rows = await self.client.location(self.session_key, start=start, end=end)
            self._ingest(rows)
            self.covered_to = end
            self.error = None
        except OpenF1Error as exc:
            self.error = str(exc)
        finally:
            self._fetching = False

    def _ingest(self, rows: Sequence[dict[str, Any]]) -> None:
        grouped: dict[int, list[tuple[dt.datetime, tuple[float, float]]]] = {}
        for row in rows:
            x, y = row.get("x"), row.get("y")
            number = row.get("driver_number")
            when = parse_dt(row.get("date"))
            if x is None or y is None or number is None or when is None:
                continue
            if x == 0 and y == 0:
                continue
            grouped.setdefault(int(number), []).append((when, (float(x), float(y))))

        for number, entries in grouped.items():
            dates, points = self.samples.setdefault(number, ([], []))
            entries.sort(key=lambda item: item[0])
            for when, point in entries:
                index = bisect.bisect_left(dates, when)
                if index < len(dates) and dates[index] == when:
                    continue
                dates.insert(index, when)
                points.insert(index, point)
            # Trim history so a long session does not grow without bound.
            if len(dates) > 4000:
                del dates[:-2000]
                del points[:-2000]

    def at(self, number: int, now: dt.datetime) -> tuple[float, float] | None:
        entry = self.samples.get(number)
        if not entry:
            return None
        dates, points = entry
        if not dates:
            return None
        index = bisect.bisect_right(dates, now)
        if index == 0:
            return None
        if index >= len(dates):
            # Only trust a trailing sample briefly, or a parked car lingers.
            if (now - dates[-1]).total_seconds() > 15:
                return points[-1]
            return points[-1]
        before_t, after_t = dates[index - 1], dates[index]
        before, after = points[index - 1], points[index]
        span = (after_t - before_t).total_seconds()
        if span <= 0:
            return before
        ratio = (now - before_t).total_seconds() / span
        return (
            before[0] + (after[0] - before[0]) * ratio,
            before[1] + (after[1] - before[1]) * ratio,
        )


class SessionState:
    def __init__(self, client: OpenF1Client, session: dict[str, Any], clock: Clock) -> None:
        self.client = client
        self.session = session
        self.clock = clock
        self.session_key = int(session["session_key"])

        self.drivers: dict[int, Driver] = {}
        self.geometry: TrackGeometry | None = None
        self.weather = Weather()
        self.messages: list[RaceControlMessage] = []
        self.track_status: str = TrackStatus.UNKNOWN
        self.results: list[dict[str, Any]] = []

        self.fastest_lap: tuple[int, float] | None = None
        self.best_sectors: list[tuple[int, float] | None] = [None, None, None]
        self.leader_lap: int = 0
        self.total_laps: int | None = None

        self.location = LocationBuffer(client, self.session_key)
        self.errors: list[str] = []
        self.last_refresh: dt.datetime | None = None
        self.static_loaded = False

        self._series: dict[str, TimedSeries] = {
            name: TimedSeries() for name in ("position", "intervals", "weather", "race_control")
        }
        self._laps: list[dict[str, Any]] = []
        self._stints: list[dict[str, Any]] = []
        self._pits: list[dict[str, Any]] = []
        self._bulk_loaded = False

    # ---- identity -------------------------------------------------------

    @property
    def is_replay(self) -> bool:
        return not self.clock.is_live

    @property
    def circuit(self) -> str:
        return self.session.get("circuit_short_name") or self.session.get("location") or "—"

    @property
    def label(self) -> str:
        name = self.session.get("session_name") or self.session.get("session_type") or "Session"
        return f"{self.session.get('country_name', '')} {name}".strip()

    @property
    def start_time(self) -> dt.datetime | None:
        return parse_dt(self.session.get("date_start"))

    @property
    def end_time(self) -> dt.datetime | None:
        return parse_dt(self.session.get("date_end"))

    # ---- loading --------------------------------------------------------

    async def load_static(self) -> None:
        rows = await self.client.drivers(self.session_key)
        for row in rows:
            driver = driver_from_api(row)
            if driver.number:
                self.drivers[driver.number] = driver
        self.static_loaded = True

    async def load_geometry(self) -> TrackGeometry | None:
        """Derive the circuit outline from the fastest clean lap of the session."""
        circuit_key = self.session.get("circuit_key")
        cache_id = f"geometry-{circuit_key}-{self.session.get('year')}"
        cached = self.client.cache.get_disk("track", cache_id)
        if cached:
            self.geometry = TrackGeometry.from_dict(cached)
            return self.geometry

        try:
            laps = await self.client.laps(self.session_key)
        except OpenF1Error as exc:
            self.errors.append(f"laps: {exc}")
            return None

        clean = [
            lap
            for lap in laps
            if lap.get("lap_duration")
            and 45 < lap["lap_duration"] < 300
            and not lap.get("is_pit_out_lap")
            and lap.get("date_start")
        ]
        if not clean:
            return None
        clean.sort(key=lambda lap: lap["lap_duration"])

        for candidate in clean[:4]:
            start = parse_dt(candidate["date_start"])
            if start is None:
                continue
            end = start + dt.timedelta(seconds=candidate["lap_duration"] + 1.5)
            try:
                rows = await self.client.location(
                    self.session_key,
                    driver_number=candidate["driver_number"],
                    start=start,
                    end=end,
                    persist=True,
                )
            except OpenF1Error:
                continue
            geometry = TrackGeometry.from_samples(
                rows, circuit_key=circuit_key, circuit_name=self.circuit
            )
            if geometry is not None:
                self.geometry = geometry
                self.client.cache.set_disk("track", cache_id, geometry.to_dict())
                return geometry
        return None

    @property
    def is_finished(self) -> bool:
        end = self.end_time
        return end is not None and utcnow() > end

    async def _load_bulk(self) -> None:
        """Pull the whole session's timing once — used for replay and first paint.

        A session that has ended can never change, so its feeds are written to
        the disk cache. Without that, every restart re-downloads the same
        megabyte of timing and quickly runs into OpenF1's rate limit.
        """
        keep = self.is_finished
        key = self.session_key
        tasks = {
            "position": self.client.position(key, persist=keep),
            "intervals": self.client.intervals(key, persist=keep),
            "weather": self.client.weather(key, persist=keep),
            "race_control": self.client.race_control(key, persist=keep),
            "laps": self.client.laps(key, persist=keep),
            "stints": self.client.stints(key, persist=keep),
            "pit": self.client.pit(key, persist=keep),
            "result": self.client.session_result(key, persist=keep),
        }
        results = await asyncio.gather(*tasks.values(), return_exceptions=True)
        for name, outcome in zip(tasks, results):
            if isinstance(outcome, BaseException):
                self.errors.append(f"{name}: {outcome}")
                continue
            if name == "laps":
                self._laps = outcome
            elif name == "stints":
                self._stints = outcome
            elif name == "pit":
                self._pits = outcome
            elif name == "result":
                self.results = outcome
            else:
                self._series[name].extend(outcome)
        self._bulk_loaded = True

    async def _poll_live(self) -> None:
        cursors = {name: series.newest_date for name, series in self._series.items()}
        tasks = {
            "position": self.client.position(self.session_key, since=cursors["position"]),
            "intervals": self.client.intervals(self.session_key, since=cursors["intervals"]),
            "weather": self.client.weather(self.session_key, since=cursors["weather"]),
            "race_control": self.client.race_control(self.session_key),
            "laps": self.client.laps(self.session_key),
            "stints": self.client.stints(self.session_key),
            "pit": self.client.pit(self.session_key),
        }
        results = await asyncio.gather(*tasks.values(), return_exceptions=True)
        for name, outcome in zip(tasks, results):
            if isinstance(outcome, BaseException):
                continue
            if name == "laps":
                self._laps = outcome
            elif name == "stints":
                self._stints = outcome
            elif name == "pit":
                self._pits = outcome
            elif name == "race_control":
                self._series[name] = TimedSeries()
                self._series[name].extend(outcome)
            else:
                self._series[name].extend(outcome)

    async def refresh(self) -> None:
        now = self.clock.now()
        if not self.static_loaded:
            await self.load_static()
        if not self._bulk_loaded:
            await self._load_bulk()
        elif self.clock.is_live:
            await self._poll_live()

        await self.location.ensure(now, live=self.clock.is_live)
        self.apply(now)
        self.infer_total_laps()
        self.last_refresh = utcnow()

    # ---- projection -----------------------------------------------------

    def apply(self, now: dt.datetime) -> None:
        for driver in self.drivers.values():
            driver.position = None
            driver.gap_to_leader = None
            driver.interval = None
            driver.in_pit = False

        self._apply_positions(now)
        self._apply_intervals(now)
        self._apply_laps(now)
        self._apply_stints()
        self._apply_pits(now)
        self._apply_weather(now)
        self._apply_race_control(now)
        self.update_car_positions(now)
        self._apply_retirements(now)

    def _apply_positions(self, now: dt.datetime) -> None:
        for number, (when, row) in self._series["position"].latest_per_driver(now).items():
            driver = self.drivers.get(number)
            if driver is None:
                continue
            position = row.get("position")
            if position is not None:
                driver.position = int(position)
            driver.last_seen = when

    def _apply_intervals(self, now: dt.datetime) -> None:
        for number, (when, row) in self._series["intervals"].latest_per_driver(now).items():
            driver = self.drivers.get(number)
            if driver is None:
                continue
            driver.gap_to_leader = row.get("gap_to_leader")
            interval = row.get("interval")
            driver.interval = interval if isinstance(interval, (int, float)) else None
            if driver.last_seen is None or when > driver.last_seen:
                driver.last_seen = when

    def _apply_laps(self, now: dt.datetime) -> None:
        for driver in self.drivers.values():
            driver.lap_number = 0
            driver.last_lap = None
            driver.best_lap = None
            driver.best_sectors = [None, None, None]

        self.fastest_lap = None
        self.best_sectors = [None, None, None]

        for row in self._laps:
            number = row.get("driver_number")
            driver = self.drivers.get(int(number)) if number is not None else None
            if driver is None:
                continue
            started = parse_dt(row.get("date_start"))
            if started is None or started > now:
                continue

            lap_number = int(row.get("lap_number") or 0)
            driver.lap_number = max(driver.lap_number, lap_number)

            duration = row.get("lap_duration")
            # A lap only counts once the car has actually crossed the line.
            completed = duration is not None and started + dt.timedelta(seconds=duration) <= now
            record = LapRecord(
                lap_number=lap_number,
                date_start=started,
                duration=duration if completed else None,
                sector_1=row.get("duration_sector_1") if completed else None,
                sector_2=row.get("duration_sector_2") if completed else None,
                sector_3=row.get("duration_sector_3") if completed else None,
                i1_speed=row.get("i1_speed"),
                i2_speed=row.get("i2_speed"),
                st_speed=row.get("st_speed"),
                is_pit_out_lap=bool(row.get("is_pit_out_lap")),
                segments_sector_1=row.get("segments_sector_1") or [],
                segments_sector_2=row.get("segments_sector_2") or [],
                segments_sector_3=row.get("segments_sector_3") or [],
            )
            if not completed:
                continue

            driver.last_lap = record
            if record.is_valid:
                if driver.best_lap is None or record.duration < driver.best_lap:
                    driver.best_lap = record.duration
                if self.fastest_lap is None or record.duration < self.fastest_lap[1]:
                    self.fastest_lap = (driver.number, record.duration)

            for index, sector in enumerate(
                (record.sector_1, record.sector_2, record.sector_3)
            ):
                if sector is None or sector <= 0:
                    continue
                best = driver.best_sectors[index]
                if best is None or sector < best:
                    driver.best_sectors[index] = sector
                overall = self.best_sectors[index]
                if overall is None or sector < overall[1]:
                    self.best_sectors[index] = (driver.number, sector)

        self.leader_lap = max((d.lap_number for d in self.drivers.values()), default=0)

    def _apply_stints(self) -> None:
        for driver in self.drivers.values():
            driver.stints = []
        for row in sorted(self._stints, key=lambda r: (r.get("driver_number") or 0, r.get("stint_number") or 0)):
            number = row.get("driver_number")
            driver = self.drivers.get(int(number)) if number is not None else None
            if driver is None:
                continue
            lap_start = int(row.get("lap_start") or 0)
            current = max(driver.lap_number, 1)
            if lap_start > current:
                continue
            # A finished session reports each stint's final lap_end, so an
            # unclamped value would draw a strategy bar running past the lap
            # the replay has actually reached.
            lap_end = min(int(row.get("lap_end") or 0) or current, current)
            driver.stints.append(
                Stint(
                    stint_number=int(row.get("stint_number") or 0),
                    compound=(row.get("compound") or "UNKNOWN").upper(),
                    lap_start=lap_start,
                    lap_end=max(lap_end, lap_start),
                    tyre_age_at_start=int(row.get("tyre_age_at_start") or 0),
                )
            )

    def _apply_pits(self, now: dt.datetime) -> None:
        for driver in self.drivers.values():
            driver.pit_stops = []
        for row in self._pits:
            number = row.get("driver_number")
            driver = self.drivers.get(int(number)) if number is not None else None
            if driver is None:
                continue
            when = parse_dt(row.get("date"))
            if when is None or when > now:
                continue
            duration = row.get("pit_duration") or row.get("lane_duration")
            driver.pit_stops.append(
                PitStop(lap_number=int(row.get("lap_number") or 0), date=when, duration=duration)
            )
            window = min(float(duration or 30.0), MAX_PIT_WINDOW)
            if 0 <= (now - when).total_seconds() <= window:
                driver.in_pit = True

    def _apply_weather(self, now: dt.datetime) -> None:
        row = self._series["weather"].latest(now)
        if not row:
            return
        self.weather = Weather(
            date=parse_dt(row.get("date")),
            air_temperature=row.get("air_temperature"),
            track_temperature=row.get("track_temperature"),
            humidity=row.get("humidity"),
            pressure=row.get("pressure"),
            wind_speed=row.get("wind_speed"),
            wind_direction=row.get("wind_direction"),
            rainfall=row.get("rainfall"),
        )

    def _apply_race_control(self, now: dt.datetime) -> None:
        rows = self._series["race_control"].upto(now)
        self.messages = [
            RaceControlMessage(
                date=parse_dt(row.get("date")),
                category=row.get("category") or "Other",
                message=(row.get("message") or "").strip(),
                flag=row.get("flag"),
                scope=row.get("scope"),
                sector=row.get("sector"),
                driver_number=row.get("driver_number"),
            )
            for row in rows
        ]
        self.track_status = self._derive_track_status(self.messages)

    @staticmethod
    def _derive_track_status(messages: Sequence[RaceControlMessage]) -> str:
        status = TrackStatus.UNKNOWN
        safety_car = False
        virtual_sc = False
        for message in messages:
            text = message.message.upper()
            flag = (message.flag or "").upper()

            if "VIRTUAL SAFETY CAR" in text or "VSC" in text:
                if "END" in text or "DEPLOYED" not in text and "IN THIS LAP" in text:
                    virtual_sc = False
                elif "DEPLOYED" in text:
                    virtual_sc = True
            elif "SAFETY CAR" in text:
                if "IN THIS LAP" in text or "END" in text:
                    safety_car = False
                elif "DEPLOYED" in text:
                    safety_car = True

            if flag == "RED":
                status = TrackStatus.RED
            elif flag == "CHEQUERED":
                status = TrackStatus.CHEQUERED
            elif flag == "GREEN" or "TRACK CLEAR" in text:
                if status != TrackStatus.CHEQUERED:
                    status = TrackStatus.GREEN
            elif flag == "DOUBLE YELLOW":
                status = TrackStatus.DOUBLE_YELLOW
            elif flag == "YELLOW":
                status = TrackStatus.YELLOW
            elif flag == "CLEAR" and status in (
                TrackStatus.YELLOW,
                TrackStatus.DOUBLE_YELLOW,
            ):
                status = TrackStatus.GREEN

        if status == TrackStatus.CHEQUERED:
            return status
        if safety_car:
            return TrackStatus.SAFETY_CAR
        if virtual_sc:
            return TrackStatus.VSC
        return status

    def update_car_positions(self, now: dt.datetime) -> None:
        """Re-interpolate car coordinates only.

        The map is redrawn many times per second to keep motion smooth, and
        this is the only part of the projection that needs to run that often.
        """
        for number, driver in self.drivers.items():
            point = self.location.at(number, now)
            if point is not None:
                driver.x, driver.y = point


    def _apply_retirements(self, now: dt.datetime) -> None:
        """Decide who is out, using only what was known at ``now``.

        The final classification lists who retired but not when, so consulting
        it mid-race would show a car as OUT while the replay still has it
        circulating. What actually marks a retirement at a given moment is the
        timing feed going quiet for that car, so that is the signal used, with
        the results only confirming it once the session has ended.
        """
        past_end = self.end_time is not None and now >= self.end_time
        dnf_numbers = {
            int(row["driver_number"])
            for row in self.results
            if row.get("driver_number") is not None
            and (row.get("dnf") or row.get("dns") or row.get("dsq"))
        }
        if past_end:
            for driver in self.drivers.values():
                driver.retired = driver.number in dnf_numbers
            return

        # Silence is measured against the middle of the field rather than the
        # clock, because under a red flag every car stops reporting at once and
        # a clock comparison would retire the entire grid. The median is used
        # rather than the newest record: a single car still sending updates
        # from the pit lane would otherwise make everyone else look stopped.
        seen = sorted(d.last_seen for d in self.drivers.values() if d.last_seen is not None)
        if not seen:
            return
        feed_time = seen[len(seen) // 2]
        for driver in self.drivers.values():
            if driver.last_seen is None:
                driver.retired = bool(self.leader_lap)
                continue
            driver.retired = (
                feed_time - driver.last_seen
            ).total_seconds() > RETIREMENT_SILENCE

    # ---- derived views --------------------------------------------------

    def classification(self) -> list[Driver]:
        """Drivers in running order, with unplaced cars pushed to the back."""
        known = [d for d in self.drivers.values() if d.position]
        unknown = [d for d in self.drivers.values() if not d.position]
        known.sort(key=lambda d: d.position or 99)
        unknown.sort(key=lambda d: d.number)
        return known + unknown

    def leader(self) -> Driver | None:
        for driver in self.classification():
            if driver.position == 1:
                return driver
        return None

    def laps_remaining(self) -> int | None:
        if self.total_laps is None:
            return None
        return max(self.total_laps - self.leader_lap, 0)

    def infer_total_laps(self) -> None:
        """Race distance is not published, so take it from the final classification."""
        if self.results:
            laps = [
                int(row.get("number_of_laps") or 0)
                for row in self.results
                if row.get("number_of_laps")
            ]
            if laps:
                self.total_laps = max(laps)

    def recent_messages(self, limit: int = 40) -> list[RaceControlMessage]:
        return list(reversed(self.messages[-limit:]))

    def session_progress(self) -> float:
        if isinstance(self.clock, ReplayClock):
            return self.clock.progress
        start, end = self.start_time, self.end_time
        if not start or not end:
            return 0.0
        span = (end - start).total_seconds()
        if span <= 0:
            return 0.0
        return max(0.0, min((utcnow() - start).total_seconds() / span, 1.0))


async def resolve_session(
    client: OpenF1Client,
    *,
    session_key: int | None = None,
    year: int | None = None,
    round_name: str | None = None,
    session_type: str | None = None,
) -> dict[str, Any] | None:
    """Pick a session from a user's flags, defaulting to the most recent race."""
    if session_key is not None:
        rows = await client.sessions(session_key=session_key)
        return rows[0] if rows else None

    if year is None and round_name is None and session_type is None:
        latest = await client.latest_session()
        if latest:
            return latest

    target_year = year or utcnow().year
    rows = await client.sessions(year=target_year)
    if not rows and year is None:
        rows = await client.sessions(year=target_year - 1)
    if not rows:
        return None

    if session_type:
        wanted = session_type.lower()
        rows = [
            row
            for row in rows
            if wanted in (row.get("session_name") or "").lower()
            or wanted in (row.get("session_type") or "").lower()
        ] or rows

    if round_name:
        needle = round_name.lower()
        matched = [
            row
            for row in rows
            if needle in (row.get("circuit_short_name") or "").lower()
            or needle in (row.get("location") or "").lower()
            or needle in (row.get("country_name") or "").lower()
        ]
        if matched:
            rows = matched

    now = utcnow()
    started = [row for row in rows if (parse_dt(row.get("date_start")) or now) <= now]
    pool = started or rows
    pool.sort(key=lambda row: parse_dt(row.get("date_start")) or now)
    return pool[-1]
