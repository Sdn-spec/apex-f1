"""The live track map: circuit outline in braille with cars drawn on top."""

from __future__ import annotations

from rich.console import RenderableType
from rich.text import Text
from textual.reactive import reactive
from textual.widget import Widget

from ..data.models import Driver
from ..data.state import SessionState
from ..track import TrackProjection

CAR_GLYPH = "●"
LEADER_GLYPH = "◆"


class TrackMap(Widget):
    """Draws the circuit and every car's current position.

    Cars are stamped as whole character cells over the braille outline, because
    a braille cell can only carry one colour and team colours are the whole
    point of the view.
    """

    DEFAULT_CSS = """
    TrackMap {
        height: 1fr;
        min-height: 12;
        padding: 0 1;
    }
    """

    show_labels: reactive[bool] = reactive(True)
    show_corners: reactive[bool] = reactive(True)

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self.state: SessionState | None = None
        self.selected: int | None = None

    def update_state(self, state: SessionState) -> None:
        self.state = state
        self.refresh()

    def render(self) -> RenderableType:
        state = self.state
        width = max(self.size.width - 2, 20)
        height = max(self.size.height, 8)

        if state is None:
            return Text("connecting…", style="grey50")
        if state.geometry is None:
            return Text(
                "Deriving circuit outline from lap telemetry…", style="yellow", justify="center"
            )

        projection = TrackProjection(state.geometry, width, height, margin_cells=1)
        projection.draw_track()
        canvas = projection.canvas

        if self.show_corners:
            self._draw_corners(projection)
        self._draw_start_finish(projection)
        self._draw_cars(projection, state)

        text = Text(no_wrap=True, overflow="crop")
        for index, row in enumerate(canvas.to_lines()):
            if index:
                text.append("\n")
            for chunk, style in row:
                text.append(chunk, style=style)
        return text

    def _draw_start_finish(self, projection: TrackProjection) -> None:
        geometry = projection.geometry
        if not geometry.start_finish:
            return
        cell_x, cell_y = projection.cell(*geometry.start_finish)
        projection.canvas.put_cell(cell_x, cell_y, "▚", "bold white")

    def _draw_corners(self, projection: TrackProjection) -> None:
        canvas = projection.canvas
        if canvas.width < 46 or canvas.height < 14:
            return
        x_min, _, x_max, _ = projection.geometry.bounds
        midpoint = (x_min + x_max) / 2
        for corner in projection.geometry.corners:
            cell_x, cell_y = projection.cell(corner.x, corner.y)
            label = str(corner.number)
            # Nudge the label off the racing line so it does not hide the track,
            # towards whichever side of the circuit has room.
            outward = 1 if corner.x >= midpoint else -len(label)
            for offset in (outward, -outward if outward < 0 else -len(label)):
                target_x = cell_x + offset
                # Placing a two-digit label part-way off the canvas would clip
                # it to a single digit and mislabel the corner.
                if target_x < 0 or target_x + len(label) > canvas.width:
                    continue
                if any(canvas.cell_occupied(target_x + i, cell_y) for i in range(len(label))):
                    continue
                canvas.put_label(target_x, cell_y, label, "grey30")
                break

    def _draw_cars(self, projection: TrackProjection, state: SessionState) -> None:
        canvas = projection.canvas
        drivers = [d for d in state.drivers.values() if d.x is not None and d.y is not None]
        if not drivers:
            return

        # Draw from the back of the field forwards, so leaders end up on top.
        drivers.sort(key=lambda d: -(d.position or 99))
        placed: dict[tuple[int, int], Driver] = {}

        for driver in drivers:
            if driver.retired:
                continue
            cell = projection.cell(driver.x, driver.y)
            glyph = LEADER_GLYPH if driver.position == 1 else CAR_GLYPH
            style = f"bold {driver.style}"
            if driver.number == self.selected:
                style = f"bold {driver.style} reverse"
            elif driver.in_pit:
                style = f"{driver.style} dim"
            canvas.put_cell(cell[0], cell[1], glyph, style)
            placed[cell] = driver

        if self.show_labels:
            self._draw_labels(projection, placed)

    def _draw_labels(
        self, projection: TrackProjection, placed: dict[tuple[int, int], Driver]
    ) -> None:
        canvas = projection.canvas
        if canvas.width < 40:
            return

        # Only the selected car and the podium places get a name tag; labelling
        # twenty cars turns the map into unreadable soup.
        wanted = [
            driver
            for cell, driver in placed.items()
            if driver.number == self.selected or (driver.position or 99) <= 3
        ]
        wanted.sort(key=lambda d: (d.number != self.selected, d.position or 99))

        for driver in wanted:
            cell_x, cell_y = projection.cell(driver.x, driver.y)
            label = driver.acronym
            for dx, dy in ((2, 0), (-len(label) - 1, 0), (2, -1), (-len(label) - 1, 1)):
                start = cell_x + dx
                if start < 0 or start + len(label) > canvas.width:
                    continue
                row = cell_y + dy
                if row < 0 or row >= canvas.height:
                    continue
                if any(canvas.cell_occupied(start + i, row) for i in range(len(label))):
                    continue
                style = f"bold {driver.style}"
                canvas.put_label(start, row, label, style)
                break
