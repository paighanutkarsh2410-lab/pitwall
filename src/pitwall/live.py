"""What the pit wall shows right now: the latest board and strategy, every car's position, recent
telemetry per car, and the circuit's outline, drawn from the cars' own positions.

Pure state with no I/O; the API service feeds it from Kafka and reads frames from it for each
browser.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

TELEMETRY_KEPT = 200  # samples per car: about 50 s at ~4 per second


@dataclass
class Outline:
    """Traces one car around a lap and closes the loop when it comes back to the start."""

    car: int | None = None
    points: list[tuple[int, int]] = field(default_factory=list)
    length: float = 0.0
    done: bool = False

    def add(self, car: int, x: int, y: int) -> bool:
        """Returns True when the outline has just been completed."""
        if self.done:
            return False
        if self.car is None:
            self.car = car
        if car != self.car:
            return False
        if self.points:
            px, py = self.points[-1]
            step = math.hypot(x - px, y - py)
            if step < 40:  # stationary or noise
                return False
            if step > 3000:  # a jump (pit lane, a reset): start the trace again
                self.points, self.length = [(x, y)], 0.0
                return False
            self.length += step
        self.points.append((x, y))
        fx, fy = self.points[0]
        if len(self.points) > 150 and self.length > 20_000 and math.hypot(x - fx, y - fy) < 400:
            self.done = True
            return True
        return False

    def shape(self, keep: int = 500) -> list[tuple[int, int]]:
        stride = max(1, len(self.points) // keep)
        return self.points[::stride]


class Live:
    def __init__(self) -> None:
        self.board: dict | None = None
        self.strategy: dict | None = None
        self.board_version = 0
        self.strategy_version = 0
        self.run: str | None = None
        self.race: str | None = None
        self.outlines: dict[str, Outline] = {}
        self.reset_cars()

    def reset_cars(self) -> None:
        self.positions: dict[int, tuple[int, int, int]] = {}
        self.telemetry: dict[int, deque] = {}
        self.positions_version = 0

    # ---- Inputs -----------------------------------------------------------------------------

    def on_board(self, board: dict) -> None:
        run = board.get("run")
        if run != self.run:
            if self.run is not None and run is not None and run < self.run:
                return  # an older run's board
            self.run = run
            self.reset_cars()
        session = board.get("session") or {}
        self.race = session.get("race_id", self.race)
        self.board = board
        self.board_version += 1

    def on_strategy(self, strategy: dict) -> None:
        self.strategy = strategy
        self.strategy_version += 1

    def on_car(self, event: dict, run: str | None) -> bool:
        """A telemetry or position event. Ignored unless it belongs to the board's run."""
        if run is not None and self.run is not None and run < self.run:
            return False  # an older run's car data
        if run is not None and run != self.run:
            self.run = run  # cars of a new run can arrive before its first board
            self.reset_cars()
        car, t, d = event["car"], event["t"], event["data"]
        if event["type"] == "car.position":
            self.positions[car] = (d["x"], d["y"], t)
            self.positions_version += 1
            if event.get("race"):
                self.outline(event["race"]).add(car, d["x"], d["y"])
        elif event["type"] == "car.telemetry":
            samples = self.telemetry.setdefault(car, deque(maxlen=TELEMETRY_KEPT))
            samples.append(
                (t, d["speed"], d["throttle"], d["brake"], d["gear"], d["rpm"], d["drs"])
            )
        return True

    def outline(self, race: str) -> Outline:
        return self.outlines.setdefault(race, Outline())

    # ---- Outputs ----------------------------------------------------------------------------

    def track(self) -> dict | None:
        outline = self.outlines.get(self.race or "")
        if not outline or not outline.done:
            return None
        return {"race": self.race, "points": outline.shape()}

    def positions_frame(self) -> dict:
        return {str(car): [x, y] for car, (x, y, _) in self.positions.items()}

    def telemetry_since(self, car: int, after_t: int | None) -> list[tuple]:
        samples = self.telemetry.get(car, ())
        return [s for s in samples if after_t is None or s[0] > after_t]
