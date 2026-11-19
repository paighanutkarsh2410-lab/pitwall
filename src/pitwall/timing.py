"""The live timing board: what a pit wall shows, rebuilt from the event stream.

Pure logic with no I/O: feed it events with ``apply`` and read the board with ``snapshot``. The
timing service wraps it with Kafka; tests drive it directly.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

TRACK_PRE_RACE = "PRE_RACE"
TRACK_GREEN = "GREEN"


@dataclass
class Car:
    number: int
    code: str = ""
    name: str = ""
    team: str = ""
    colour: str | None = None
    position: int | None = None
    lap: int = 0  # the lap the car is on
    laps_done: int = 0
    last_lap_ms: int | None = None
    best_lap_ms: int | None = None
    personal_best: bool = False  # the last lap was the car's best so far
    sectors_ms: list[int | None] = field(default_factory=lambda: [None, None, None])
    # Each sector of the last lap as the timing screens colour it: purple (fastest of anyone so
    # far), green (the car's own best) or yellow.
    sector_status: list[str | None] = field(default_factory=lambda: [None, None, None])
    best_sectors_ms: list[int | None] = field(default_factory=lambda: [None, None, None])
    start_position: int | None = None
    gap_to_leader: float | str | None = None
    interval: float | str | None = None
    gap_t: int | None = None  # race time of the interval event the gaps came from
    compound: str | None = None
    tyre_age_start: int = 0
    stint_lap_start: int = 1
    stint: int = 0
    pits: int = 0
    pit_until_t: int | None = None
    last_pit: dict | None = None

    def tyre_age(self) -> int | None:
        if self.compound is None:
            return None
        return self.tyre_age_start + max(0, self.lap - self.stint_lap_start)


class Board:
    def __init__(self, messages: int = 8) -> None:
        self.messages_kept = messages
        self.reset()

    def reset(self, run: str | None = None) -> None:
        self.run = run
        self.session: dict | None = None
        self.cars: dict[int, Car] = {}
        self.t = 0
        self.lap = 0
        self.track = TRACK_PRE_RACE
        self.yellow_sectors: set[int] = set()
        self.weather: dict | None = None
        self.messages: deque[dict] = deque(maxlen=self.messages_kept)
        self.fastest: tuple[int, int] | None = None  # (ms, car)
        self.best_sectors: list[int | None] = [None, None, None]

    def car(self, number: int) -> Car:
        if number not in self.cars:
            self.cars[number] = Car(number=number, code=f"#{number}")
        return self.cars[number]

    def apply(self, event: dict, run: str | None = None) -> bool:
        """Updates the board. Returns False, changing nothing, for an older run's events.

        Run ids sort by start time, so arrival order across partitions doesn't matter."""
        if run is not None and run != self.run:
            if self.run is not None and run < self.run:
                return False  # a straggler from a run that has been replaced
            self.reset(run)
        self.t = max(self.t, event["t"])
        handler = getattr(self, "_" + event["type"].replace(".", "_"), None)
        if handler:
            handler(event, event["data"], event.get("car"))
        return True

    # ---- Handlers ---------------------------------------------------------------------------

    def _session_info(self, e: dict, d: dict, _: None) -> None:
        if self.session and self.session.get("race_id") != d["race_id"]:
            self.reset(self.run)
        self.session = {k: v for k, v in d.items() if k != "drivers"}
        for driver in d["drivers"]:
            c = self.car(driver["number"])
            c.code, c.name, c.team, c.colour = (
                driver["code"],
                driver["name"],
                driver["team"],
                driver.get("colour"),
            )

    def _lap_started(self, e: dict, d: dict, car: int) -> None:
        c = self.car(car)
        c.lap = d["lap"]
        if d["lap"] > self.lap:
            self.lap = d["lap"]
        if self.track == TRACK_PRE_RACE:
            self.track = TRACK_GREEN

    def _lap_completed(self, e: dict, d: dict, car: int) -> None:
        c = self.car(car)
        c.laps_done = max(c.laps_done, d["lap"])
        c.sectors_ms = list(d["sectors_ms"])
        c.sector_status = [self._sector(c, i, ms) for i, ms in enumerate(d["sectors_ms"][:3])]
        c.last_lap_ms = d["lap_time_ms"]
        c.personal_best = False
        ms = d["lap_time_ms"]
        if ms is not None and (c.best_lap_ms is None or ms < c.best_lap_ms):
            c.best_lap_ms = ms
            c.personal_best = True
            if self.fastest is None or ms < self.fastest[0]:
                self.fastest = (ms, car)

    def _sector(self, c: Car, i: int, ms: int | None) -> str | None:
        if ms is None:
            return None
        best, own = self.best_sectors[i], c.best_sectors_ms[i]
        if own is None or ms < own:
            c.best_sectors_ms[i] = ms
        if best is None or ms <= best:
            self.best_sectors[i] = ms
            return "purple"
        return "green" if own is None or ms <= own else "yellow"

    def _race_position(self, e: dict, d: dict, car: int) -> None:
        c = self.car(car)
        c.position = d["position"]
        if c.start_position is None and self.lap <= 1:
            c.start_position = d["position"]

    def _race_interval(self, e: dict, d: dict, car: int) -> None:
        c = self.car(car)
        c.gap_to_leader, c.interval, c.gap_t = d["gap_to_leader"], d["interval"], e["t"]

    def _tyre_stint(self, e: dict, d: dict, car: int) -> None:
        c = self.car(car)
        c.stint, c.compound = d["stint"], d["compound"]
        c.tyre_age_start, c.stint_lap_start = d["tyre_age"], d["lap_start"]

    def _pit_stop(self, e: dict, d: dict, car: int) -> None:
        c = self.car(car)
        c.pits += 1
        c.last_pit = {"lap": d["lap"], "pit_lane_ms": d["pit_lane_ms"], "stop_ms": d["stop_ms"]}
        # A red-flag stop is logged as one pit visit lasting the whole stoppage (half an hour at
        # São Paulo 2024), which kept every car "in the pit" for laps after the restart. A real
        # stop takes well under a minute, so that is as long as the badge stays up.
        lane_ms = d["pit_lane_ms"] or 25_000
        c.pit_until_t = e["t"] + min(lane_ms, PIT_LANE_MAX_MS)

    def _weather(self, e: dict, d: dict, _: None) -> None:
        self.weather = d

    def _race_control(self, e: dict, d: dict, car: int | None) -> None:
        self.messages.appendleft(
            {
                "t": e["t"],
                "category": d["category"],
                "flag": d.get("flag"),
                "message": d["message"],
                "car": car,
            }
        )
        self.track = track_status(self.track, d, self.yellow_sectors)

    # ---- Output -----------------------------------------------------------------------------

    def snapshot(self) -> dict:
        cars = sorted(
            self.cars.values(),
            key=lambda c: (c.position is None, c.position or 99, c.number),
        )
        fastest_car = self.fastest[1] if self.fastest else None
        return {
            "run": self.run,
            "t": self.t,
            "session": self.session,
            "lap": self.lap,
            "laps": (self.session or {}).get("laps"),
            "track": self.track,
            "yellow_sectors": sorted(self.yellow_sectors),
            "weather": self.weather,
            "messages": list(self.messages),
            "best_sectors_ms": self.best_sectors,
            "fastest_lap": (
                {"car": fastest_car, "lap_time_ms": self.fastest[0]} if self.fastest else None
            ),
            "cars": [
                {
                    "car": c.number,
                    "code": c.code,
                    "name": c.name,
                    "team": c.team,
                    "colour": c.colour,
                    "position": c.position,
                    "lap": c.lap,
                    "gap_to_leader": c.gap_to_leader,
                    "interval": c.interval,
                    "gap_t": c.gap_t,
                    "last_lap_ms": c.last_lap_ms,
                    "best_lap_ms": c.best_lap_ms,
                    "personal_best": c.personal_best,
                    "fastest_lap": c.number == fastest_car,
                    "sectors_ms": c.sectors_ms,
                    "sector_status": c.sector_status,
                    "best_sectors_ms": c.best_sectors_ms,
                    "start_position": c.start_position,
                    "compound": c.compound,
                    "tyre_age": c.tyre_age(),
                    "pits": c.pits,
                    "in_pit": c.pit_until_t is not None and self.t < c.pit_until_t,
                    "last_pit": c.last_pit,
                }
                for c in cars
            ],
        }


PIT_LANE_MAX_MS = 60_000


def track_status(current: str, d: dict, yellow_sectors: set[int]) -> str:
    """Track status from a race-control message, the way the timing screens show it."""
    message, flag, scope = d["message"].upper(), (d.get("flag") or "").upper(), d.get("scope")
    if scope == "Sector" and d.get("sector") is not None:
        if flag in {"YELLOW", "DOUBLE YELLOW"}:
            yellow_sectors.add(d["sector"])
        elif flag in {"CLEAR", "GREEN"}:
            yellow_sectors.discard(d["sector"])
        return current
    if flag == "CHEQUERED":
        return "CHEQUERED"
    if flag == "RED" or "RED FLAG" in message:
        return "RED"
    if "VIRTUAL SAFETY CAR DEPLOYED" in message:
        return "VSC"
    if "VIRTUAL SAFETY CAR ENDING" in message or "VSC ENDING" in message:
        return "VSC_ENDING"
    if "SAFETY CAR DEPLOYED" in message:
        return "SC"
    if "SAFETY CAR IN THIS LAP" in message:
        return "SC_ENDING"
    if flag == "GREEN" and scope == "Track":
        yellow_sectors.clear()
        return TRACK_GREEN
    if "TRACK CLEAR" in message:
        yellow_sectors.clear()
        return TRACK_GREEN
    return current
