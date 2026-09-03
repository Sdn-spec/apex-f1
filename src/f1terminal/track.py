"""Circuit geometry and the braille track-map renderer.

OpenF1 publishes car coordinates in a flat track-local frame (roughly decimetres,
origin near the circuit centre). There is no published circuit outline, so the
outline here is *derived*: take one clean flying lap of a single car and treat
its racing line as the centreline. Corners are then found by looking for
sustained heading change along that line.

Rendering uses Unicode braille. A braille cell packs 2x4 dots, and because a
terminal cell is about twice as tall as it is wide, those dots come out very
close to square — so x and y can share one scale factor and the circuit keeps
its true shape.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Sequence

# Braille dot bit for each (column, row) offset within a 2x4 cell.
BRAILLE_BITS = (
    (0x01, 0x02, 0x04, 0x40),
    (0x08, 0x10, 0x20, 0x80),
)
BRAILLE_BASE = 0x2800

Point = tuple[float, float]


@dataclass
class Corner:
    number: int
    x: float
    y: float
    angle: float  # total heading change through the corner, radians
    direction: str  # "L" or "R"
    distance: float  # metres from the start/finish line

    @property
    def severity(self) -> str:
        degrees = abs(math.degrees(self.angle))
        if degrees > 120:
            return "hairpin"
        if degrees > 70:
            return "slow"
        if degrees > 35:
            return "medium"
        return "fast"


@dataclass
class TrackGeometry:
    """An ordered, closed loop of centreline points plus derived features."""

    points: list[Point]
    circuit_key: int | None = None
    circuit_name: str = ""
    start_finish: Point | None = None
    corners: list[Corner] = field(default_factory=list)
    pit_lane: list[Point] = field(default_factory=list)

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        xs = [p[0] for p in self.points]
        ys = [p[1] for p in self.points]
        if self.pit_lane:
            xs += [p[0] for p in self.pit_lane]
            ys += [p[1] for p in self.pit_lane]
        return min(xs), min(ys), max(xs), max(ys)

    @property
    def length(self) -> float:
        """Approximate lap length in metres (OpenF1 units are ~decimetres)."""
        return _path_length(self.points) / 10.0

    def nearest_index(self, x: float, y: float) -> int:
        best_i, best_d = 0, float("inf")
        for i, (px, py) in enumerate(self.points):
            d = (px - x) ** 2 + (py - y) ** 2
            if d < best_d:
                best_d, best_i = d, i
        return best_i

    def to_dict(self) -> dict:
        return {
            "points": self.points,
            "circuit_key": self.circuit_key,
            "circuit_name": self.circuit_name,
            "start_finish": self.start_finish,
            "pit_lane": self.pit_lane,
            "corners": [
                {
                    "number": c.number,
                    "x": c.x,
                    "y": c.y,
                    "angle": c.angle,
                    "direction": c.direction,
                    "distance": c.distance,
                }
                for c in self.corners
            ],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "TrackGeometry":
        return cls(
            points=[tuple(p) for p in data.get("points", [])],
            circuit_key=data.get("circuit_key"),
            circuit_name=data.get("circuit_name", ""),
            start_finish=tuple(data["start_finish"]) if data.get("start_finish") else None,
            pit_lane=[tuple(p) for p in data.get("pit_lane", [])],
            corners=[Corner(**c) for c in data.get("corners", [])],
        )

    @classmethod
    def from_samples(
        cls,
        samples: Iterable[dict],
        *,
        circuit_key: int | None = None,
        circuit_name: str = "",
    ) -> "TrackGeometry | None":
        raw: list[Point] = []
        for row in samples:
            x, y = row.get("x"), row.get("y")
            if x is None or y is None:
                continue
            if x == 0 and y == 0:
                continue
            raw.append((float(x), float(y)))
        if len(raw) < 40:
            return None

        points = _dedupe(raw)
        points = _drop_stationary(points)
        if len(points) < 40:
            return None
        points = _resample(points, step=_suggest_step(points))
        points = _smooth(points, window=3)
        if len(points) < 30:
            return None

        geometry = cls(points=points, circuit_key=circuit_key, circuit_name=circuit_name)
        geometry.start_finish = points[0]
        geometry.corners = detect_corners(points)
        return geometry


def _path_length(points: Sequence[Point]) -> float:
    return sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))


def _dedupe(points: Sequence[Point]) -> list[Point]:
    out: list[Point] = []
    for p in points:
        if not out or math.dist(out[-1], p) > 1e-6:
            out.append(p)
    return out


def _drop_stationary(points: Sequence[Point], min_move: float = 5.0) -> list[Point]:
    """Remove runs where the car barely moved (grid, red flag, pit box)."""
    out: list[Point] = []
    for p in points:
        if not out or math.dist(out[-1], p) >= min_move:
            out.append(p)
    return out


def _suggest_step(points: Sequence[Point]) -> float:
    total = _path_length(points)
    return max(total / 1500.0, 1.0)


def _resample(points: Sequence[Point], step: float) -> list[Point]:
    """Re-space points evenly along the path so curvature maths is well behaved."""
    if len(points) < 2:
        return list(points)
    out: list[Point] = [points[0]]
    carry = 0.0
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        seg = math.dist(a, b)
        if seg <= 0:
            continue
        travelled = carry
        while travelled + step <= seg:
            travelled += step
            t = travelled / seg
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        carry = travelled - seg
    return out


def _smooth(points: Sequence[Point], window: int = 3) -> list[Point]:
    """Moving average with clamped edges.

    Edges are clamped rather than wrapped: a lap trace rarely closes exactly on
    the start/finish line, so wrapping would blend the overshoot into the first
    corner and bend the geometry at the seam.
    """
    if window < 2 or len(points) < window * 2:
        return list(points)
    n = len(points)
    out: list[Point] = []
    for i in range(n):
        xs = ys = 0.0
        for k in range(-window, window + 1):
            px, py = points[min(max(i + k, 0), n - 1)]
            xs += px
            ys += py
        count = window * 2 + 1
        out.append((xs / count, ys / count))
    return out


def _heading(a: Point, b: Point) -> float:
    return math.atan2(b[1] - a[1], b[0] - a[0])


def _wrap(angle: float) -> float:
    return (angle + math.pi) % (2 * math.pi) - math.pi


def _turn_rates(points: Sequence[Point]) -> list[float]:
    """Per-step heading change. Summing a slice gives that slice's true turn angle.

    The path is treated as open. A derived lap trace overshoots the start/finish
    line by a few metres, so the closing segment points backwards along the
    track; wrapping the derivative across that seam injects a phantom
    half-turn that smears into a fake corner.
    """
    n = len(points)
    deltas = [0.0] * n
    for i in range(1, n - 1):
        prev, here, nxt = points[i - 1], points[i], points[i + 1]
        if here == prev or nxt == here:
            continue
        deltas[i] = _wrap(_heading(here, nxt) - _heading(prev, here))
    return deltas


def _moving_average(values: Sequence[float], half_width: int) -> list[float]:
    n = len(values)
    if half_width < 1 or n == 0:
        return list(values)
    window = half_width * 2 + 1
    return [
        sum(values[min(max(i + k, 0), n - 1)] for k in range(-half_width, half_width + 1))
        / window
        for i in range(n)
    ]


def detect_corners(
    points: Sequence[Point],
    *,
    smooth_window: int = 6,
    enter_radius: float = 1700.0,
    exit_radius: float = 4200.0,
    min_total: float = math.radians(22.0),
    max_gap_units: float = 260.0,
) -> list[Corner]:
    """Find corners as sustained runs of same-signed curvature along the lap.

    Thresholds are expressed as turn radii in OpenF1 units (~decimetres) rather
    than as a per-sample angle, so they mean the same thing on a 3 km street
    circuit as on a 7 km road course. A corner is entered when the radius drops
    below ``enter_radius`` and only released once it opens back out past
    ``exit_radius`` — hysteresis, so a mid-corner easing does not split one turn
    into two. Totals are summed from the raw per-step deltas, making the
    reported angle the real heading change through the corner.
    """
    n = len(points)
    if n < 60:
        return []

    raw = _turn_rates(points)
    smoothed = _moving_average(raw, smooth_window)

    cumulative = [0.0]
    for k in range(1, n):
        cumulative.append(cumulative[-1] + math.dist(points[k - 1], points[k]))
    step = cumulative[-1] / max(n - 1, 1)
    if step <= 0:
        return []

    enter = step / enter_radius
    release = step / exit_radius
    max_gap = max(int(max_gap_units / step), 2)

    # Walked in order rather than cyclically: the trace begins on the
    # start/finish straight, so no corner spans the seam.
    order = range(n)

    runs: list[tuple[list[int], int]] = []
    current: list[int] = []
    sign = 0
    gap = 0

    def flush() -> None:
        nonlocal current, sign, gap
        if current:
            while current and abs(smoothed[current[-1]]) < release:
                current.pop()
            if current:
                runs.append((current, sign))
        current, sign, gap = [], 0, 0

    for idx in order:
        value = smoothed[idx]
        this_sign = 1 if value >= 0 else -1
        if not current:
            if abs(value) >= enter:
                current, sign, gap = [idx], this_sign, 0
            continue
        if this_sign != sign and abs(value) >= enter:
            flush()
            current, sign, gap = [idx], this_sign, 0
            continue
        if abs(value) >= release and this_sign == sign:
            current.append(idx)
            gap = 0
            continue
        gap += 1
        if gap > max_gap:
            flush()
        else:
            current.append(idx)
    flush()

    corners: list[Corner] = []
    for indices, run_sign in runs:
        total = sum(raw[i] for i in indices)
        if abs(total) < min_total:
            continue
        apex = max(indices, key=lambda i: abs(smoothed[i]))
        ax, ay = points[apex]
        corners.append(
            Corner(
                number=0,
                x=ax,
                y=ay,
                angle=total,
                direction="L" if run_sign > 0 else "R",
                distance=cumulative[apex] / 10.0,
            )
        )

    corners.sort(key=lambda c: c.distance)
    for index, corner in enumerate(corners, start=1):
        corner.number = index
    return corners


class BrailleCanvas:
    """A dot bitmap that renders to braille glyphs, with a per-cell colour overlay."""

    def __init__(self, width: int, height: int) -> None:
        self.width = max(width, 1)
        self.height = max(height, 1)
        self.dot_width = self.width * 2
        self.dot_height = self.height * 4
        self._dots = bytearray(self.width * self.height)
        self._colours: dict[int, str] = {}
        self._overlay: dict[int, tuple[str, str]] = {}
        # Multi-character labels are tracked as groups so that a marker drawn
        # over one of their cells removes the whole label. Otherwise a car
        # landing on corner "10" would leave a lone "0" on the map.
        self._groups: dict[int, int] = {}
        self._group_cells: dict[int, list[int]] = {}

    def set_dot(self, x: int, y: int, colour: str | None = None) -> None:
        if not (0 <= x < self.dot_width and 0 <= y < self.dot_height):
            return
        cell_x, cell_y = x // 2, y // 4
        index = cell_y * self.width + cell_x
        self._dots[index] |= BRAILLE_BITS[x % 2][y % 4]
        if colour:
            self._colours[index] = colour

    def line(self, x0: int, y0: int, x1: int, y1: int, colour: str | None = None) -> None:
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx = 1 if x0 < x1 else -1
        sy = 1 if y0 < y1 else -1
        err = dx + dy
        guard = 0
        while guard < 10_000:
            guard += 1
            self.set_dot(x0, y0, colour)
            if x0 == x1 and y0 == y1:
                break
            err2 = err * 2
            if err2 >= dy:
                err += dy
                x0 += sx
            if err2 <= dx:
                err += dx
                y0 += sy

    def put_cell(self, cell_x: int, cell_y: int, text: str, style: str) -> None:
        """Stamp a whole character cell, replacing any braille underneath."""
        if not (0 <= cell_x < self.width and 0 <= cell_y < self.height):
            return
        index = cell_y * self.width + cell_x
        self._erase_group_at(index)
        self._overlay[index] = (text, style)

    def _erase_group_at(self, index: int) -> None:
        group = self._groups.pop(index, None)
        if group is None:
            return
        for cell in self._group_cells.pop(group, ()):
            self._groups.pop(cell, None)
            self._overlay.pop(cell, None)

    def put_label(self, cell_x: int, cell_y: int, text: str, style: str) -> None:
        """Draw a label whose cells are erased together if anything overwrites it."""
        if not text:
            return
        cells: list[int] = []
        for offset, char in enumerate(text):
            x = cell_x + offset
            if not (0 <= x < self.width and 0 <= cell_y < self.height):
                continue
            index = cell_y * self.width + x
            self._erase_group_at(index)
            self._overlay[index] = (char, style)
            cells.append(index)
        if len(cells) > 1:
            group = cells[0]
            self._group_cells[group] = cells
            for index in cells:
                self._groups[index] = group

    def cell_occupied(self, cell_x: int, cell_y: int) -> bool:
        return (cell_y * self.width + cell_x) in self._overlay

    def to_lines(self, base_style: str = "grey35") -> list[list[tuple[str, str]]]:
        """Rows of (text, style) runs, ready to feed a Rich Text object."""
        lines: list[list[tuple[str, str]]] = []
        for cell_y in range(self.height):
            row: list[tuple[str, str]] = []
            for cell_x in range(self.width):
                index = cell_y * self.width + cell_x
                if index in self._overlay:
                    row.append(self._overlay[index])
                    continue
                bits = self._dots[index]
                if bits:
                    row.append((chr(BRAILLE_BASE + bits), self._colours.get(index, base_style)))
                else:
                    row.append((" ", base_style))
            lines.append(_merge_runs(row))
        return lines


def _merge_runs(cells: list[tuple[str, str]]) -> list[tuple[str, str]]:
    merged: list[tuple[str, str]] = []
    for text, style in cells:
        if merged and merged[-1][1] == style:
            merged[-1] = (merged[-1][0] + text, style)
        else:
            merged.append((text, style))
    return merged


class TrackProjection:
    """Maps track coordinates onto braille dots, preserving aspect ratio."""

    def __init__(
        self,
        geometry: TrackGeometry,
        width: int,
        height: int,
        *,
        margin_cells: int = 2,
    ) -> None:
        self.geometry = geometry
        self.canvas = BrailleCanvas(width, height)
        x0, y0, x1, y1 = geometry.bounds
        span_x = max(x1 - x0, 1.0)
        span_y = max(y1 - y0, 1.0)

        pad_x = margin_cells * 2
        pad_y = margin_cells * 4
        usable_x = max(self.canvas.dot_width - pad_x * 2, 4)
        usable_y = max(self.canvas.dot_height - pad_y * 2, 4)

        self.scale = min(usable_x / span_x, usable_y / span_y)
        used_x = span_x * self.scale
        used_y = span_y * self.scale
        self.offset_x = (self.canvas.dot_width - used_x) / 2.0
        self.offset_y = (self.canvas.dot_height - used_y) / 2.0
        self._x0, self._y0, self._y1 = x0, y0, y1

    def dot(self, x: float, y: float) -> tuple[int, int]:
        dx = (x - self._x0) * self.scale + self.offset_x
        # Track y grows north; screen y grows south.
        dy = (self._y1 - y) * self.scale + self.offset_y
        return int(round(dx)), int(round(dy))

    def cell(self, x: float, y: float) -> tuple[int, int]:
        dx, dy = self.dot(x, y)
        return dx // 2, dy // 4

    def draw_track(self, style: str = "grey42", pit_style: str = "grey27") -> None:
        points = self.geometry.points
        if len(points) > 1:
            projected = [self.dot(*p) for p in points]
            for i in range(len(projected) - 1):
                (x0, y0), (x1, y1) = projected[i], projected[i + 1]
                self.canvas.line(x0, y0, x1, y1, style)
            # Close the loop back to the start/finish line.
            (xa, ya), (xb, yb) = projected[-1], projected[0]
            if math.dist(projected[-1], projected[0]) < self.canvas.dot_width / 2:
                self.canvas.line(xa, ya, xb, yb, style)

        if self.geometry.pit_lane:
            pit = [self.dot(*p) for p in self.geometry.pit_lane]
            for i in range(len(pit) - 1):
                (x0, y0), (x1, y1) = pit[i], pit[i + 1]
                self.canvas.line(x0, y0, x1, y1, pit_style)
