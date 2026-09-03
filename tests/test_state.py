"""Projection tests: what the app knows at a given moment, and no more.

The recurring hazard in replaying a finished session is leaking the future —
the feeds contain the whole race, so a projection that forgets to respect
"now" will show a retirement, a stint or a lap time before it happened.
"""

from __future__ import annotations

import datetime as dt

import pytest

from f1terminal.data.models import (
    Driver,
    TrackStatus,
    format_gap,
    format_lap_time,
    wind_arrow,
)
from f1terminal.data.state import (
    ReplayClock,
    SessionState,
    TimedSeries,
)

START = dt.datetime(2026, 8, 23, 13, 0, tzinfo=dt.timezone.utc)
END = START + dt.timedelta(hours=2)


def at(seconds: float) -> dt.datetime:
    return START + dt.timedelta(seconds=seconds)


def iso(seconds: float) -> str:
    return at(seconds).isoformat()


class FakeClient:
    """Stands in for OpenF1Client; the projection never calls it in these tests."""

    class _Cache:
        def get_disk(self, *args, **kwargs):
            return None

        def set_disk(self, *args, **kwargs):
            return None

    def __init__(self) -> None:
        self.cache = self._Cache()


def build_state(*, drivers=(1, 44, 63), results=None) -> SessionState:
    session = {
        "session_key": 1,
        "date_start": START.isoformat(),
        "date_end": END.isoformat(),
        "circuit_short_name": "Testing",
        "country_name": "Nowhere",
        "session_name": "Race",
        "year": 2026,
    }
    clock = ReplayClock(START, END)
    clock.paused = True
    state = SessionState(FakeClient(), session, clock)
    palette = {1: ("VER", "Red Bull"), 44: ("HAM", "Ferrari"), 63: ("RUS", "Mercedes")}
    for number in drivers:
        acronym, team = palette.get(number, (str(number), "Team"))
        state.drivers[number] = Driver(
            number=number, acronym=acronym, full_name=acronym, team=team
        )
    state.static_loaded = True
    state.results = results or []
    return state


class TestTimedSeries:
    def test_upto_respects_the_cutoff(self) -> None:
        series = TimedSeries()
        series.extend([{"date": iso(t), "driver_number": 1} for t in (10, 20, 30)])
        assert len(series.upto(at(25))) == 2

    def test_latest_per_driver_returns_newest_each(self) -> None:
        series = TimedSeries()
        series.extend(
            [
                {"date": iso(10), "driver_number": 1, "position": 1},
                {"date": iso(20), "driver_number": 1, "position": 2},
                {"date": iso(15), "driver_number": 44, "position": 3},
            ]
        )
        latest = series.latest_per_driver(at(30))
        assert latest[1][1]["position"] == 2
        assert latest[44][1]["position"] == 3

    def test_boundary_records_are_not_duplicated(self) -> None:
        """Polling with an inclusive filter re-sends the record on the cursor."""
        series = TimedSeries()
        row = {"date": iso(10), "driver_number": 1}
        series.extend([row])
        series.extend([dict(row)])
        assert len(series.rows) == 1

    def test_out_of_order_records_are_inserted_sorted(self) -> None:
        series = TimedSeries()
        series.extend([{"date": iso(30), "driver_number": 1}])
        series.extend([{"date": iso(10), "driver_number": 2}])
        assert series.dates == sorted(series.dates)

    def test_rows_without_a_date_are_ignored(self) -> None:
        series = TimedSeries()
        series.extend([{"driver_number": 1}, {"date": None, "driver_number": 2}])
        assert series.rows == []


class TestReplayClock:
    def test_starts_at_the_beginning(self) -> None:
        clock = ReplayClock(START, END)
        clock.paused = True
        assert clock.now() == START

    def test_seek_is_clamped_to_the_session(self) -> None:
        clock = ReplayClock(START, END)
        clock.paused = True
        clock.seek(-9999)
        assert clock.now() == START
        clock.seek(99999)
        assert clock.now() == END

    def test_seek_fraction_lands_midway(self) -> None:
        clock = ReplayClock(START, END)
        clock.paused = True
        clock.seek_fraction(0.5)
        assert clock.progress == pytest.approx(0.5, abs=0.01)

    def test_speed_is_bounded(self) -> None:
        clock = ReplayClock(START, END)
        clock.set_speed(1000)
        assert clock.speed <= 60
        clock.set_speed(0.001)
        assert clock.speed >= 0.25

    def test_pause_toggles(self) -> None:
        clock = ReplayClock(START, END)
        assert clock.toggle_pause() is True
        assert clock.toggle_pause() is False

    def test_replay_clock_is_not_live(self) -> None:
        assert ReplayClock(START, END).is_live is False


class TestLapProjection:
    def _state_with_laps(self) -> SessionState:
        state = build_state()
        state._laps = [
            {
                "driver_number": 1,
                "lap_number": 1,
                "date_start": iso(0),
                "lap_duration": 90.0,
                "duration_sector_1": 30.0,
                "duration_sector_2": 30.0,
                "duration_sector_3": 30.0,
            },
            {
                "driver_number": 44,
                "lap_number": 1,
                "date_start": iso(0),
                "lap_duration": 88.0,
                "duration_sector_1": 29.0,
                "duration_sector_2": 29.0,
                "duration_sector_3": 30.0,
            },
        ]
        return state

    def test_a_lap_in_progress_has_no_time_yet(self) -> None:
        """The lap started but has not been completed at this moment."""
        state = self._state_with_laps()
        state.apply(at(45))
        assert state.drivers[1].last_lap is None
        assert state.drivers[1].lap_number == 1

    def test_a_lap_counts_once_the_line_is_crossed(self) -> None:
        state = self._state_with_laps()
        state.apply(at(95))
        assert state.drivers[1].last_lap is not None
        assert state.drivers[1].last_lap.duration == pytest.approx(90.0)

    def test_fastest_lap_tracks_the_session_best(self) -> None:
        state = self._state_with_laps()
        state.apply(at(200))
        assert state.fastest_lap == (44, 88.0)

    def test_best_sectors_are_attributed_to_a_driver(self) -> None:
        state = self._state_with_laps()
        state.apply(at(200))
        assert state.best_sectors[0] == (44, 29.0)
        assert state.best_sectors[2][1] == pytest.approx(30.0)

    def test_pit_out_laps_do_not_set_a_best_lap(self) -> None:
        state = build_state()
        state._laps = [
            {
                "driver_number": 1,
                "lap_number": 1,
                "date_start": iso(0),
                "lap_duration": 70.0,
                "is_pit_out_lap": True,
            }
        ]
        state.apply(at(200))
        assert state.drivers[1].best_lap is None
        assert state.fastest_lap is None


class TestStintProjection:
    def test_stints_are_clamped_to_the_current_lap(self) -> None:
        """A finished session reports the final lap_end; a replay must not see it."""
        state = build_state()
        state._laps = [
            {"driver_number": 1, "lap_number": n, "date_start": iso(n * 60),
             "lap_duration": 60.0}
            for n in range(1, 11)
        ]
        state._stints = [
            {"driver_number": 1, "stint_number": 1, "lap_start": 1, "lap_end": 40,
             "compound": "SOFT", "tyre_age_at_start": 0}
        ]
        state.apply(at(5 * 60 + 30))
        stint = state.drivers[1].current_stint
        assert stint is not None
        assert stint.lap_end <= state.drivers[1].lap_number

    def test_a_future_stint_is_not_shown(self) -> None:
        state = build_state()
        state._laps = [
            {"driver_number": 1, "lap_number": 1, "date_start": iso(0), "lap_duration": 60.0}
        ]
        state._stints = [
            {"driver_number": 1, "stint_number": 1, "lap_start": 1, "lap_end": 1,
             "compound": "SOFT", "tyre_age_at_start": 0},
            {"driver_number": 1, "stint_number": 2, "lap_start": 30, "lap_end": 50,
             "compound": "HARD", "tyre_age_at_start": 0},
        ]
        state.apply(at(90))
        assert [s.compound for s in state.drivers[1].stints] == ["SOFT"]

    def test_tyre_age_grows_with_the_stint(self) -> None:
        state = build_state()
        state._laps = [
            {"driver_number": 1, "lap_number": n, "date_start": iso(n * 60),
             "lap_duration": 60.0}
            for n in range(1, 11)
        ]
        state._stints = [
            {"driver_number": 1, "stint_number": 1, "lap_start": 1, "lap_end": 20,
             "compound": "HARD", "tyre_age_at_start": 3}
        ]
        state.apply(at(9 * 60 + 30))
        assert state.drivers[1].tyre_age == 3 + (state.drivers[1].lap_number - 1)


class TestPitProjection:
    def test_a_driver_is_in_the_pits_during_the_stop(self) -> None:
        state = build_state()
        state._pits = [
            {"driver_number": 1, "lap_number": 10, "date": iso(600), "pit_duration": 25.0}
        ]
        state.apply(at(610))
        assert state.drivers[1].in_pit is True

    def test_a_driver_leaves_the_pits_afterwards(self) -> None:
        state = build_state()
        state._pits = [
            {"driver_number": 1, "lap_number": 10, "date": iso(600), "pit_duration": 25.0}
        ]
        state.apply(at(700))
        assert state.drivers[1].in_pit is False
        assert state.drivers[1].stop_count == 1

    def test_a_red_flag_stop_does_not_pin_a_driver_in_the_pits(self) -> None:
        """Stops served under a red flag report durations of many minutes."""
        state = build_state()
        state._pits = [
            {"driver_number": 1, "lap_number": 2, "date": iso(120), "pit_duration": 1571.5}
        ]
        state.apply(at(600))
        assert state.drivers[1].in_pit is False

    def test_a_future_stop_is_not_counted(self) -> None:
        state = build_state()
        state._pits = [
            {"driver_number": 1, "lap_number": 40, "date": iso(3000), "pit_duration": 25.0}
        ]
        state.apply(at(600))
        assert state.drivers[1].stop_count == 0


class TestRetirement:
    def _positions(self, entries) -> TimedSeries:
        series = TimedSeries()
        series.extend(entries)
        return series

    def test_a_silent_car_is_retired(self) -> None:
        state = build_state()
        state._series["position"] = self._positions(
            [
                {"date": iso(100), "driver_number": 1, "position": 1},
                {"date": iso(3000), "driver_number": 44, "position": 1},
                {"date": iso(3000), "driver_number": 63, "position": 2},
            ]
        )
        state.apply(at(3100))
        assert state.drivers[1].retired is True
        assert state.drivers[44].retired is False

    def test_a_red_flag_does_not_retire_the_whole_field(self) -> None:
        """Under a stoppage every car goes quiet at once; nobody has retired."""
        state = build_state()
        state._series["position"] = self._positions(
            [
                {"date": iso(100), "driver_number": number, "position": index}
                for index, number in enumerate((1, 44, 63), start=1)
            ]
        )
        state.apply(at(2000))
        assert [d.retired for d in state.drivers.values()] == [False, False, False]

    def test_one_car_still_reporting_does_not_retire_everyone_else(self) -> None:
        """A car sitting in the pit lane keeps sending; it must not skew the anchor."""
        state = build_state(drivers=(1, 44, 63))
        state._series["position"] = self._positions(
            [
                {"date": iso(100), "driver_number": 1, "position": 1},
                {"date": iso(100), "driver_number": 44, "position": 2},
                {"date": iso(3000), "driver_number": 63, "position": 3},
            ]
        )
        state.apply(at(3100))
        assert state.drivers[1].retired is False
        assert state.drivers[44].retired is False

    def test_after_the_session_the_official_result_decides(self) -> None:
        state = build_state(
            results=[
                {"driver_number": 1, "dnf": True, "number_of_laps": 20},
                {"driver_number": 44, "dnf": False, "number_of_laps": 50},
                {"driver_number": 63, "dnf": False, "number_of_laps": 50},
            ]
        )
        state.apply(END + dt.timedelta(minutes=1))
        assert state.drivers[1].retired is True
        assert state.drivers[44].retired is False

    def test_total_laps_come_from_the_final_classification(self) -> None:
        state = build_state(
            results=[
                {"driver_number": 1, "number_of_laps": 72},
                {"driver_number": 44, "number_of_laps": 70},
            ]
        )
        state.infer_total_laps()
        assert state.total_laps == 72


class TestTrackStatus:
    def _status(self, messages) -> str:
        state = build_state()
        series = TimedSeries()
        series.extend(messages)
        state._series["race_control"] = series
        state.apply(at(9999))
        return state.track_status

    def test_green_flag(self) -> None:
        assert self._status(
            [{"date": iso(10), "category": "Flag", "flag": "GREEN", "message": "GREEN LIGHT"}]
        ) == TrackStatus.GREEN

    def test_safety_car_deployed_then_ending(self) -> None:
        deployed = {
            "date": iso(10),
            "category": "SafetyCar",
            "message": "SAFETY CAR DEPLOYED",
        }
        assert self._status([deployed]) == TrackStatus.SAFETY_CAR
        ending = {
            "date": iso(60),
            "category": "SafetyCar",
            "message": "SAFETY CAR IN THIS LAP",
        }
        assert self._status([deployed, ending]) != TrackStatus.SAFETY_CAR

    def test_virtual_safety_car_is_distinct(self) -> None:
        assert self._status(
            [{"date": iso(10), "category": "SafetyCar",
              "message": "VIRTUAL SAFETY CAR DEPLOYED"}]
        ) == TrackStatus.VSC

    def test_red_flag(self) -> None:
        assert self._status(
            [{"date": iso(10), "category": "Flag", "flag": "RED", "message": "RED FLAG"}]
        ) == TrackStatus.RED

    def test_chequered_flag_wins_over_a_later_safety_car(self) -> None:
        assert self._status(
            [
                {"date": iso(10), "category": "SafetyCar", "message": "SAFETY CAR DEPLOYED"},
                {"date": iso(20), "category": "Flag", "flag": "CHEQUERED",
                 "message": "CHEQUERED FLAG"},
            ]
        ) == TrackStatus.CHEQUERED

    def test_messages_after_now_are_not_seen(self) -> None:
        state = build_state()
        series = TimedSeries()
        series.extend(
            [{"date": iso(5000), "category": "Flag", "flag": "RED", "message": "RED FLAG"}]
        )
        state._series["race_control"] = series
        state.apply(at(100))
        assert state.track_status != TrackStatus.RED


class TestClassification:
    def test_orders_by_position_and_parks_unplaced_cars_last(self) -> None:
        state = build_state()
        series = TimedSeries()
        series.extend(
            [
                {"date": iso(10), "driver_number": 44, "position": 1},
                {"date": iso(10), "driver_number": 63, "position": 2},
            ]
        )
        state._series["position"] = series
        state.apply(at(20))
        order = [d.number for d in state.classification()]
        assert order[:2] == [44, 63]
        assert order[-1] == 1

    def test_lapped_runners_keep_their_gap_string(self) -> None:
        state = build_state()
        series = TimedSeries()
        series.extend(
            [{"date": iso(10), "driver_number": 1, "gap_to_leader": "+1 LAP",
              "interval": 3.5}]
        )
        state._series["intervals"] = series
        state.apply(at(20))
        assert state.drivers[1].gap_to_leader == "+1 LAP"


class TestFormatting:
    @pytest.mark.parametrize(
        "seconds,expected",
        [(None, "—"), (83.456, "1:23.456"), (59.999, "59.999"), (-1, "—")],
    )
    def test_lap_times(self, seconds, expected) -> None:
        assert format_lap_time(seconds) == expected

    def test_gap_formatting(self) -> None:
        assert format_gap(None) == "—"
        assert format_gap(1.5) == "+1.500"
        assert format_gap(0.0, leader=True) == "LEADER"
        assert format_gap("+1 LAP") == "+1 L"

    def test_wind_arrow_points_the_right_way(self) -> None:
        assert wind_arrow(None) == ""
        assert wind_arrow(0) == "↑"
        assert wind_arrow(90) == "→"
        assert wind_arrow(180) == "↓"
        assert wind_arrow(270) == "←"

    def test_driver_status_labels(self) -> None:
        driver = Driver(number=1, acronym="VER", full_name="V", team="T")
        assert driver.status_label.strip() == ""
        driver.in_pit = True
        assert driver.status_label == "PIT"
        driver.retired = True
        assert driver.status_label == "OUT"
