"""Geometry and rendering tests, driven by synthetic circuits with known shapes."""

from __future__ import annotations

import math

import pytest

from f1terminal.track import (
    BrailleCanvas,
    TrackGeometry,
    TrackProjection,
    _turn_rates,
    detect_corners,
)


def rounded_rectangle(
    width: float = 6000.0,
    height: float = 3000.0,
    radius: float = 600.0,
    step: float = 20.0,
) -> list[tuple[float, float]]:
    """A circuit with four exact 90-degree corners joined by straights."""
    points: list[tuple[float, float]] = []

    def straight(x0: float, y0: float, x1: float, y1: float) -> None:
        span = math.dist((x0, y0), (x1, y1))
        for i in range(int(span // step)):
            t = i * step / span
            points.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))

    def arc(cx: float, cy: float, start: float, end: float) -> None:
        span = abs(end - start) * radius
        count = max(int(span // step), 2)
        for i in range(count):
            angle = start + (end - start) * (i / count)
            points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))

    right, top = width - radius, height - radius
    straight(radius, 0, right, 0)
    arc(right, radius, -math.pi / 2, 0)
    straight(width, radius, width, top)
    arc(right, top, 0, math.pi / 2)
    straight(right, height, radius, height)
    arc(radius, top, math.pi / 2, math.pi)
    straight(0, top, 0, radius)
    arc(radius, radius, math.pi, 3 * math.pi / 2)
    return points


def as_samples(points: list[tuple[float, float]]) -> list[dict]:
    return [{"x": x, "y": y} for x, y in points]


class TestGeometry:
    def test_builds_from_samples(self) -> None:
        geometry = TrackGeometry.from_samples(as_samples(rounded_rectangle()))
        assert geometry is not None
        assert len(geometry.points) > 100
        assert geometry.start_finish == geometry.points[0]

    def test_rejects_too_few_samples(self) -> None:
        assert TrackGeometry.from_samples([{"x": 1, "y": 2}] * 10) is None

    def test_ignores_origin_and_null_rows(self) -> None:
        samples = as_samples(rounded_rectangle())
        polluted = [{"x": 0, "y": 0}, {"x": None, "y": 5}] + samples
        geometry = TrackGeometry.from_samples(polluted)
        assert geometry is not None
        assert (0.0, 0.0) not in geometry.points

    def test_length_matches_perimeter(self) -> None:
        # Perimeter of the rounded rectangle: straights plus one full circle.
        width, height, radius = 6000.0, 3000.0, 600.0
        expected = 2 * (width - 2 * radius) + 2 * (height - 2 * radius)
        expected += 2 * math.pi * radius
        geometry = TrackGeometry.from_samples(as_samples(rounded_rectangle()))
        assert geometry is not None
        # Smoothing rounds the corners slightly, so allow a small shortfall.
        assert geometry.length == pytest.approx(expected / 10.0, rel=0.03)

    def test_closed_loop_turns_through_one_full_circle(self) -> None:
        """A lap is one winding; this catches a seam that doubles back."""
        geometry = TrackGeometry.from_samples(as_samples(rounded_rectangle()))
        assert geometry is not None
        total = math.degrees(sum(_turn_rates(geometry.points)))
        assert abs(total) == pytest.approx(360.0, abs=12.0)


class TestCornerDetection:
    def test_finds_four_right_angles(self) -> None:
        geometry = TrackGeometry.from_samples(as_samples(rounded_rectangle()))
        assert geometry is not None
        corners = geometry.corners
        assert len(corners) == 4
        for corner in corners:
            assert abs(math.degrees(corner.angle)) == pytest.approx(90.0, abs=15.0)

    def test_corners_are_numbered_in_lap_order(self) -> None:
        geometry = TrackGeometry.from_samples(as_samples(rounded_rectangle()))
        assert geometry is not None
        numbers = [c.number for c in geometry.corners]
        distances = [c.distance for c in geometry.corners]
        assert numbers == sorted(numbers) == list(range(1, len(numbers) + 1))
        assert distances == sorted(distances)

    def test_all_corners_same_handedness_for_one_direction_loop(self) -> None:
        geometry = TrackGeometry.from_samples(as_samples(rounded_rectangle()))
        assert geometry is not None
        assert len({c.direction for c in geometry.corners}) == 1

    def test_a_straight_line_has_no_corners(self) -> None:
        points = [(float(i) * 20, 0.0) for i in range(400)]
        assert detect_corners(points) == []

    def test_severity_buckets(self) -> None:
        geometry = TrackGeometry.from_samples(as_samples(rounded_rectangle()))
        assert geometry is not None
        assert all(c.severity in {"fast", "medium", "slow", "hairpin"} for c in geometry.corners)

    def test_roundtrips_through_dict(self) -> None:
        geometry = TrackGeometry.from_samples(as_samples(rounded_rectangle()))
        assert geometry is not None
        restored = TrackGeometry.from_dict(geometry.to_dict())
        assert restored.points == geometry.points
        assert [c.number for c in restored.corners] == [c.number for c in geometry.corners]
        assert restored.corners[0].angle == pytest.approx(geometry.corners[0].angle)


class TestBrailleCanvas:
    def test_single_dot_sets_expected_glyph(self) -> None:
        canvas = BrailleCanvas(4, 2)
        canvas.set_dot(0, 0)
        assert canvas.to_lines()[0][0][0].startswith("⠁")

    def test_dots_in_one_cell_combine(self) -> None:
        canvas = BrailleCanvas(2, 1)
        canvas.set_dot(0, 0)
        canvas.set_dot(1, 3)
        # Dot 1 (0x01) plus dot 8 (0x80).
        assert chr(0x2800 | 0x01 | 0x80) in canvas.to_lines()[0][0][0]

    def test_out_of_range_dots_are_dropped(self) -> None:
        canvas = BrailleCanvas(2, 1)
        canvas.set_dot(-1, 0)
        canvas.set_dot(99, 99)
        assert canvas.to_lines()[0][0][0].strip() == ""

    def test_line_connects_two_points(self) -> None:
        canvas = BrailleCanvas(10, 2)
        canvas.line(0, 0, 19, 0)
        rendered = "".join(chunk for chunk, _ in canvas.to_lines()[0])
        assert " " not in rendered

    def test_put_cell_overrides_braille(self) -> None:
        canvas = BrailleCanvas(3, 1)
        canvas.set_dot(0, 0)
        canvas.put_cell(0, 0, "X", "red")
        assert canvas.to_lines()[0][0][0].startswith("X")

    def test_overwriting_part_of_a_label_erases_all_of_it(self) -> None:
        """A car landing on corner '10' must not leave a stray '0' behind."""
        canvas = BrailleCanvas(6, 1)
        canvas.put_label(0, 0, "10", "grey30")
        canvas.put_cell(0, 0, "●", "red")
        rendered = "".join(chunk for chunk, _ in canvas.to_lines()[0])
        assert "0" not in rendered
        assert "●" in rendered

    def test_single_character_labels_are_not_grouped(self) -> None:
        canvas = BrailleCanvas(6, 1)
        canvas.put_label(0, 0, "3", "grey30")
        canvas.put_label(2, 0, "7", "grey30")
        canvas.put_cell(0, 0, "●", "red")
        rendered = "".join(chunk for chunk, _ in canvas.to_lines()[0])
        assert "7" in rendered

    def test_cell_occupied_tracks_overlay(self) -> None:
        canvas = BrailleCanvas(4, 1)
        assert not canvas.cell_occupied(1, 0)
        canvas.put_cell(1, 0, "A", "white")
        assert canvas.cell_occupied(1, 0)


class TestProjection:
    def test_preserves_aspect_ratio(self) -> None:
        geometry = TrackGeometry.from_samples(as_samples(rounded_rectangle()))
        assert geometry is not None
        projection = TrackProjection(geometry, 80, 24)
        x0, y0, x1, y1 = geometry.bounds
        # One scale factor for both axes means the shape is not stretched.
        left, _ = projection.dot(x0, y0)
        right, _ = projection.dot(x1, y0)
        _, bottom = projection.dot(x0, y0)
        _, top = projection.dot(x0, y1)
        drawn_ratio = (right - left) / max(bottom - top, 1)
        assert drawn_ratio == pytest.approx((x1 - x0) / (y1 - y0), rel=0.05)

    def test_north_is_up(self) -> None:
        geometry = TrackGeometry.from_samples(as_samples(rounded_rectangle()))
        assert geometry is not None
        projection = TrackProjection(geometry, 80, 24)
        _, low = projection.dot(0, 0)
        _, high = projection.dot(0, 3000)
        assert high < low

    def test_all_points_land_inside_the_canvas(self) -> None:
        geometry = TrackGeometry.from_samples(as_samples(rounded_rectangle()))
        assert geometry is not None
        projection = TrackProjection(geometry, 60, 20)
        for x, y in geometry.points:
            cell_x, cell_y = projection.cell(x, y)
            assert 0 <= cell_x < projection.canvas.width
            assert 0 <= cell_y < projection.canvas.height

    def test_draw_track_marks_the_canvas(self) -> None:
        geometry = TrackGeometry.from_samples(as_samples(rounded_rectangle()))
        assert geometry is not None
        projection = TrackProjection(geometry, 60, 20)
        projection.draw_track()
        painted = sum(
            1
            for row in projection.canvas.to_lines()
            for chunk, _ in row
            for char in chunk
            if char != " "
        )
        assert painted > 50
