"""Tyre strategy from the stream: stints, pace, degradation and what a pit stop costs.

Degradation is the slope of lap time against tyre age over a stint's *clean* laps: no out-laps,
no in-laps, nothing under a safety car, virtual safety car or red flag, and nothing slower than
107% of the stint's median (traffic, mistakes). Pit loss is the field's median time in the pit
lane. Pure logic; the strategy service wraps it with Kafka.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from statistics import median

from pitwall.timing import track_status

NEUTRALISED = {"SC", "SC_ENDING", "VSC", "VSC_ENDING", "RED"}
MIN_LAPS_FOR_TREND = 3
SLOW_LAP = 1.07


@dataclass
class Stint:
    number: int
    compound: str
    lap_start: int
    tyre_age: int
    laps: dict[int, int] = field(default_factory=dict)  # lap -> lap time, clean laps only
    last_lap: int | None = None

    def clean_laps(self) -> list[tuple[int, int]]:
        if not self.laps:
            return []
        typical = median(self.laps.values())
        return sorted((lap, ms) for lap, ms in self.laps.items() if ms <= typical * SLOW_LAP)

    def summary(self) -> dict:
        clean = self.clean_laps()
        pace = round(median(ms for _, ms in clean)) if clean else None
        return {
            "stint": self.number,
            "compound": self.compound,
            "lap_start": self.lap_start,
            "lap_end": self.last_lap,
            "tyre_age_start": self.tyre_age,
            "clean_laps": len(clean),
            "pace_ms": pace,
            "deg_ms_per_lap": degradation(clean),
        }


def degradation(laps: list[tuple[int, int]]) -> float | None:
    """Least-squares slope of lap time (ms) against lap number: ms lost per lap of tyre age."""
    if len(laps) < MIN_LAPS_FOR_TREND:
        return None
    xs = [lap for lap, _ in laps]
    ys = [ms for _, ms in laps]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    spread = sum((x - mx) ** 2 for x in xs)
    if spread == 0:
        return None
    return round(sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True)) / spread, 1)


class Strategy:
    def __init__(self) -> None:
        self.reset()

    def reset(self, run: str | None = None) -> None:
        self.run = run
        self.t = 0
        self.stints: dict[int, list[Stint]] = {}
        self.pit_lane_ms: list[int] = []
        self.pit_laps: dict[int, set[int]] = {}
        self.neutralised_laps: set[int] = set()
        self.track = "PRE_RACE"
        self.leader_lap = 0
        self.yellow: set[int] = set()

    def apply(self, event: dict, run: str | None = None) -> bool:
        if run is not None and run != self.run:
            if self.run is not None and run < self.run:
                return False  # an older run's straggler (run ids sort by start time)
            self.reset(run)
        self.t = max(self.t, event["t"])
        kind, d, car = event["type"], event["data"], event.get("car")
        if kind == "session.info":
            if self.stints:
                self.reset(self.run)
        elif kind == "tyre.stint":
            stints = self.stints.setdefault(car, [])
            if not any(s.number == d["stint"] for s in stints):
                stints.append(Stint(d["stint"], d["compound"], d["lap_start"], d["tyre_age"]))
                stints.sort(key=lambda s: s.number)
        elif kind == "lap.started":
            self.leader_lap = max(self.leader_lap, d["lap"])
            if self.track in NEUTRALISED:
                self.neutralised_laps.add(d["lap"])
        elif kind == "race.control":
            self.track = track_status(self.track, d, self.yellow)
            if self.track in NEUTRALISED:
                self.neutralised_laps.add(self.leader_lap)
        elif kind == "pit.stop":
            self.pit_laps.setdefault(car, set()).add(d["lap"])
            if d["pit_lane_ms"] and d["pit_lane_ms"] < 60_000:  # not a red-flag stop
                self.pit_lane_ms.append(d["pit_lane_ms"])
            for stint in self.stints.get(car, []):
                stint.laps.pop(d["lap"], None)  # the in-lap isn't clean
        elif kind == "lap.completed":
            self._lap(car, d)
        else:
            return True
        return True

    def _lap(self, car: int, d: dict) -> None:
        stint = self.current(car, d["lap"])
        if stint is None:
            return
        stint.last_lap = max(stint.last_lap or 0, d["lap"])
        clean = (
            d["lap_time_ms"] is not None
            and not d["pit_out_lap"]
            and d["lap"] != stint.lap_start  # the first lap of a stint is an out-lap or the start
            and d["lap"] not in self.pit_laps.get(car, set())
            and d["lap"] not in self.neutralised_laps
        )
        if clean:
            stint.laps[d["lap"]] = d["lap_time_ms"]

    def current(self, car: int, lap: int) -> Stint | None:
        candidates = [s for s in self.stints.get(car, []) if s.lap_start <= lap]
        return candidates[-1] if candidates else None

    def snapshot(self) -> dict:
        cars = {}
        for car, stints in self.stints.items():
            summaries = [s.summary() for s in stints]
            cars[str(car)] = {
                "stints": summaries,
                "compound": summaries[-1]["compound"] if summaries else None,
                "deg_ms_per_lap": summaries[-1]["deg_ms_per_lap"] if summaries else None,
                "pits": len(self.pit_laps.get(car, set())),
            }
        return {
            "run": self.run,
            "t": self.t,
            "pit_loss_ms": round(median(self.pit_lane_ms)) if self.pit_lane_ms else None,
            "neutralised_laps": sorted(self.neutralised_laps),
            "cars": cars,
        }
