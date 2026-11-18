"""Turns a race on OpenF1 into a Pitwall race file: every event, in time order, on disk.

    ~/.pitwall/races/2024-sao-paulo/
        parts/<table>.jsonl.gz   one OpenF1 table as events, sorted by time (resumable download)
        race.jsonl.gz            every event of the race, merged in time order
        race.json                the session, event counts and when each lap started

Downloading once and replaying from disk keeps replays fast, repeatable and offline, and asks
OpenF1 for each race only once.
"""

from __future__ import annotations

import gzip
import heapq
import json
import os
import re
import unicodedata
from collections import Counter
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from pitwall.events import SCHEMA_VERSION
from pitwall.openf1 import OpenF1

Progress = Callable[[str], None]
RACE_ID = re.compile(r"^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)$")

# Per-car tables; everything else is fetched for the whole race at once.
PER_CAR = {"car_data": "car.telemetry", "location": "car.position"}
RACE_WIDE = ("laps", "stints", "pit", "position", "intervals", "race_control", "weather")


def home() -> Path:
    return Path(os.environ.get("PITWALL_HOME") or Path.home() / ".pitwall")


def slugify(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


# ---- Finding races ----------------------------------------------------------------------------


@dataclass(frozen=True)
class RaceRef:
    id: str
    session_key: int
    meeting_key: int
    location: str
    country: str
    circuit: str
    starts_at: datetime


def _ref(session: dict) -> RaceRef:
    start = parse_time(session["date_start"])
    return RaceRef(
        id=f"{start.year}-{slugify(session['location'])}",
        session_key=session["session_key"],
        meeting_key=session["meeting_key"],
        location=session["location"],
        country=session["country_name"],
        circuit=session["circuit_short_name"],
        starts_at=start,
    )


def list_races(api: OpenF1, year: int) -> list[RaceRef]:
    sessions = api.get("sessions", year=year, session_name="Race")
    races = [_ref(s) for s in sessions if not s.get("is_cancelled")]
    return sorted(races, key=lambda r: r.starts_at)


def find_race(api: OpenF1, race_id: str) -> RaceRef:
    """Finds a race by id, e.g. 2024-sao-paulo; the country or circuit also work (2024-brazil)."""
    match = RACE_ID.match(race_id)
    if not match:
        raise LookupError(f"'{race_id}' is not a race id; use YEAR-place, e.g. 2024-sao-paulo")
    year, place = int(match[1]), match[2]
    races = list_races(api, year)
    for race in races:
        if place in {slugify(race.location), slugify(race.country), slugify(race.circuit)}:
            return race
    known = ", ".join(r.id for r in races) or "none"
    raise LookupError(f"No {year} race called '{place}'. Races that year: {known}")


# ---- Time -------------------------------------------------------------------------------------


def parse_time(value: str) -> datetime:
    when = datetime.fromisoformat(value)
    return when if when.tzinfo else when.replace(tzinfo=UTC)


def iso(when: datetime) -> str:
    return when.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{when.microsecond // 1000:03d}Z"


def _event(kind: str, when: datetime, start: datetime, car: int | None, data: dict) -> dict:
    t = round((when - start).total_seconds() * 1000)
    return {"type": kind, "t": t, "at": iso(when), "car": car, "data": data}


def _ms(seconds: float | None) -> int | None:
    return None if seconds is None else round(seconds * 1000)


def _int(value: object, default: int = 0) -> int:
    return default if value is None else int(value)  # type: ignore[call-overload]


def _sorted(events: Iterable[dict]) -> list[dict]:
    return sorted(events, key=lambda e: e["t"])


# ---- OpenF1 tables to events ------------------------------------------------------------------


def telemetry(rows: list[dict], start: datetime) -> list[dict]:
    return _sorted(
        _event(
            "car.telemetry",
            parse_time(r["date"]),
            start,
            r["driver_number"],
            {
                "speed": _int(r.get("speed")),
                "rpm": _int(r.get("rpm")),
                "gear": _int(r.get("n_gear")),
                "throttle": _int(r.get("throttle")),
                "brake": _int(r.get("brake")),
                "drs": _int(r.get("drs")),
            },
        )
        for r in rows
    )


def positions(rows: list[dict], start: datetime) -> list[dict]:
    return _sorted(
        _event(
            "car.position",
            parse_time(r["date"]),
            start,
            r["driver_number"],
            {"x": _int(r.get("x")), "y": _int(r.get("y")), "z": _int(r.get("z"))},
        )
        for r in rows
    )


def lap_starts(rows: list[dict]) -> dict[tuple[int, int], datetime]:
    return {
        (r["driver_number"], r["lap_number"]): parse_time(r["date_start"])
        for r in rows
        if r.get("date_start")
    }


def laps(rows: list[dict], start: datetime) -> list[dict]:
    """lap.started when a car crosses the line, lap.completed when it crosses it again.

    A lap with no recorded time (a red flag, a retirement) still ends when the next one starts.
    """
    starts = lap_starts(rows)
    events = []
    for r in rows:
        car, lap = r["driver_number"], r["lap_number"]
        began = starts.get((car, lap))
        if began:
            events.append(_event("lap.started", began, start, car, {"lap": lap}))
        duration = r.get("lap_duration")
        if began and duration:
            ended = began + timedelta(seconds=duration)
        else:
            ended = starts.get((car, lap + 1))
        if ended is None:
            continue
        sectors = [_ms(r.get(f"duration_sector_{n}")) for n in (1, 2, 3)]
        events.append(
            _event(
                "lap.completed",
                ended,
                start,
                car,
                {
                    "lap": lap,
                    "lap_time_ms": _ms(duration),
                    "sectors_ms": sectors,
                    "pit_out_lap": bool(r.get("is_pit_out_lap")),
                    "speed_trap_kph": r.get("st_speed"),
                },
            )
        )
    return _sorted(events)


def stints(
    rows: list[dict], starts: dict[tuple[int, int], datetime], start: datetime
) -> list[dict]:
    """A stint is announced when its first lap starts (OpenF1 gives laps, not times, for stints)."""
    race_start = min(starts.values(), default=start)
    events = []
    for r in rows:
        car = r["driver_number"]
        when = starts.get((car, r["lap_start"]), race_start)
        data = {
            "stint": r["stint_number"],
            "compound": r.get("compound") or "UNKNOWN",
            "lap_start": r["lap_start"],
            "lap_end": r.get("lap_end"),
            "tyre_age": _int(r.get("tyre_age_at_start")),
        }
        events.append(_event("tyre.stint", when, start, car, data))
    return _sorted(events)


def pits(rows: list[dict], start: datetime) -> list[dict]:
    return _sorted(
        _event(
            "pit.stop",
            parse_time(r["date"]),
            start,
            r["driver_number"],
            {
                "lap": r["lap_number"],
                "pit_lane_ms": _ms(r.get("lane_duration") or r.get("pit_duration")),
                "stop_ms": _ms(r.get("stop_duration")),
            },
        )
        for r in rows
    )


def race_positions(rows: list[dict], start: datetime) -> list[dict]:
    return _sorted(
        _event(
            "race.position",
            parse_time(r["date"]),
            start,
            r["driver_number"],
            {"position": r["position"]},
        )
        for r in rows
    )


def intervals(rows: list[dict], start: datetime) -> list[dict]:
    return _sorted(
        _event(
            "race.interval",
            parse_time(r["date"]),
            start,
            r["driver_number"],
            {"gap_to_leader": r.get("gap_to_leader"), "interval": r.get("interval")},
        )
        for r in rows
    )


def race_control(rows: list[dict], start: datetime) -> list[dict]:
    return _sorted(
        _event(
            "race.control",
            parse_time(r["date"]),
            start,
            r.get("driver_number"),
            {
                "category": r.get("category") or "Other",
                "message": r.get("message") or "",
                "flag": r.get("flag"),
                "scope": r.get("scope"),
                "sector": r.get("sector"),
                "lap": r.get("lap_number"),
            },
        )
        for r in rows
    )


def weather(rows: list[dict], start: datetime) -> list[dict]:
    return _sorted(
        _event(
            "weather",
            parse_time(r["date"]),
            start,
            None,
            {
                "air_c": r["air_temperature"],
                "track_c": r["track_temperature"],
                "humidity": r["humidity"],
                "pressure_mbar": r["pressure"],
                "rainfall": bool(r.get("rainfall")),
                "wind_ms": r["wind_speed"],
                "wind_dir": _int(r.get("wind_direction")),
            },
        )
        for r in rows
    )


# ---- Download ---------------------------------------------------------------------------------


def race_dir(race_id: str) -> Path:
    return home() / "races" / race_id


def _write_jsonl(path: Path, events: Iterable[dict]) -> int:
    """Writes atomically, so an interrupted download never leaves a half-written part."""
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".partial")
    count = 0
    with gzip.open(partial, "wt", encoding="utf-8", compresslevel=6) as out:
        for event in events:
            out.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
            count += 1
    partial.replace(path)
    return count


def read_jsonl(path: Path) -> Iterator[dict]:
    with gzip.open(path, "rt", encoding="utf-8") as lines:
        for line in lines:
            yield json.loads(line)


def session_info(ref: RaceRef, meeting: dict, drivers: list[dict], lap_rows: list[dict]) -> dict:
    return {
        "race_id": ref.id,
        "name": meeting.get("meeting_name") or f"{ref.location} Grand Prix",
        "circuit": ref.circuit,
        "location": ref.location,
        "country": ref.country,
        "year": ref.starts_at.year,
        "starts_at": iso(ref.starts_at),
        "laps": max((r["lap_number"] for r in lap_rows), default=None),
        "drivers": [
            {
                "number": d["driver_number"],
                "code": d.get("name_acronym") or str(d["driver_number"]),
                "name": d.get("full_name") or d.get("broadcast_name") or "",
                "team": d.get("team_name") or "",
                "colour": d.get("team_colour"),
                "country": d.get("country_code"),
            }
            for d in sorted(drivers, key=lambda d: d["driver_number"])
        ],
    }


def fetch(api: OpenF1, race_id: str, progress: Progress = print, force: bool = False) -> Path:
    """Downloads a race (skipping parts already on disk) and builds its race file."""
    ref = find_race(api, race_id)
    target = race_dir(ref.id)
    parts = target / "parts"
    if force and target.exists():
        for old in parts.glob("*.jsonl.gz*"):
            old.unlink()
    progress(
        f"{ref.location} {ref.starts_at.year} ({ref.circuit}), OpenF1 session {ref.session_key}"
    )

    meeting = (api.get("meetings", meeting_key=ref.meeting_key) or [{}])[0]
    drivers = api.get("drivers", session_key=ref.session_key)
    lap_rows = api.get("laps", session_key=ref.session_key)
    if not drivers or not lap_rows:
        raise LookupError(f"OpenF1 has no timing data for {ref.id} yet")
    info = session_info(ref, meeting, drivers, lap_rows)
    target.mkdir(parents=True, exist_ok=True)
    (target / "session.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), "utf-8")

    start, starts = ref.starts_at, lap_starts(lap_rows)
    tables: dict[str, Callable[[list[dict]], list[dict]]] = {
        "laps": lambda rows: laps(rows, start),
        "stints": lambda rows: stints(rows, starts, start),
        "pit": lambda rows: pits(rows, start),
        "position": lambda rows: race_positions(rows, start),
        "intervals": lambda rows: intervals(rows, start),
        "race_control": lambda rows: race_control(rows, start),
        "weather": lambda rows: weather(rows, start),
    }
    for table in RACE_WIDE:
        part = parts / f"{table}.jsonl.gz"
        if part.exists():
            continue
        rows = lap_rows if table == "laps" else api.get(table, session_key=ref.session_key)
        progress(f"  {table}: {_write_jsonl(part, tables[table](rows)):,} events")

    convert = {"car_data": telemetry, "location": positions}
    for i, driver in enumerate(info["drivers"], 1):
        for table in PER_CAR:
            part = parts / f"{table}-{driver['number']:02d}.jsonl.gz"
            if part.exists():
                continue
            rows = api.get(table, session_key=ref.session_key, driver_number=driver["number"])
            count = _write_jsonl(part, convert[table](rows, start))
            progress(
                f"  [{i:2d}/{len(info['drivers'])}] {driver['code']} {table}: {count:,} events"
            )

    return build(target)


# ---- Build ------------------------------------------------------------------------------------


def build(target: Path) -> Path:
    """Merges every part into race.jsonl.gz in time order and writes race.json."""
    info = json.loads((target / "session.json").read_text("utf-8"))
    race_id = info["race_id"]
    part_files = sorted((target / "parts").glob("*.jsonl.gz"))
    merged = heapq.merge(*(read_jsonl(p) for p in part_files), key=lambda e: e["t"])

    by_type: Counter[str] = Counter()
    first_lap_start: dict[int, int] = {}
    span: dict[str, int] = {}

    def envelope() -> Iterator[dict]:
        seq = 0
        for event in merged:
            if seq == 0:
                header = {"type": "session.info", "t": event["t"], "at": event["at"], "car": None}
                yield _envelope(race_id, seq, {**header, "data": info})
                by_type["session.info"] += 1
                seq += 1
            yield _envelope(race_id, seq, event)
            seq += 1
            by_type[event["type"]] += 1
            if event["type"] == "lap.started":
                first_lap_start.setdefault(event["data"]["lap"], event["t"])
            span.setdefault("first", event["t"])
            span["last"] = event["t"]

    count = _write_jsonl(target / "race.jsonl.gz", envelope())
    summary = {
        "race_id": race_id,
        "schema": SCHEMA_VERSION,
        "events": count,
        "by_type": dict(sorted(by_type.items())),
        "first_t": span.get("first", 0),
        "last_t": span.get("last", 0),
        "lap_starts": {str(lap): t for lap, t in sorted(first_lap_start.items())},
        "session": info,
    }
    (target / "race.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), "utf-8")
    return target


def _envelope(race_id: str, seq: int, event: dict) -> dict:
    return {
        "v": SCHEMA_VERSION,
        "type": event["type"],
        "race": race_id,
        "seq": seq,
        "t": event["t"],
        "at": event["at"],
        "car": event["car"],
        "data": event["data"],
    }


def summary(race_id: str) -> dict | None:
    path = race_dir(race_id) / "race.json"
    return json.loads(path.read_text("utf-8")) if path.exists() else None
