"""The home page's race catalogue: every race from 2023 on, its winner and the car that won it.

    python scripts/race_catalogue.py site/builds/home/public/races.json [--years 2023-2026]

For each completed race, from OpenF1 (a handful of small requests, not a whole race download):
the winner (number, name, team, colour), which car won it (matched against the home page's
cars.config.json by season and team), the winner's grid slot, winning margin, best lap and pit
stops, and the winner's real telemetry from 4 s before lights out to 12 s after, which the page
plays as the car revs and launches. Existing entries are kept, so a rerun only fetches new races.
"""

from __future__ import annotations

import json
import sys
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from pitwall import race as races  # noqa: E402
from pitwall.openf1 import OpenF1  # noqa: E402

CARS = ROOT / "site" / "builds" / "home" / "cars.config.json"


def car_for(season: int, team: str, cars: list[dict]) -> str | None:
    t = team.lower()
    for car in cars:
        if car["season"] == season and (car["team"].lower() in t or t in car["team"].lower()):
            return car["id"]
    return None


def launch(rows: list[dict]) -> int | None:
    """Index of lights out: of the moments the car pulls away from a standstill (the formation
    lap and the start), the one with the hardest acceleration."""
    best, best_speed = None, 0.0
    for i in range(1, len(rows)):
        if rows[i - 1]["speed"] > 3 or rows[i]["speed"] <= 3:
            continue
        t0 = races.parse_time(rows[i]["date"])
        later = [
            r["speed"]
            for r in rows[i : i + 40]
            if races.parse_time(r["date"]) - t0 <= timedelta(seconds=4)
        ]
        if later and max(later) > best_speed:
            best, best_speed = i, max(later)
    return best if best_speed > 60 else None


def entry(api: OpenF1, ref: races.RaceRef, meeting: dict, cars: list[dict]) -> dict | None:
    key = ref.session_key
    results = sorted(
        api.get("session_result", session_key=key), key=lambda r: r.get("position") or 99
    )
    if not results or results[0].get("position") != 1:
        return None
    winner = results[0]["driver_number"]
    driver = (api.get("drivers", session_key=key, driver_number=winner) or [{}])[0]
    second = next((r for r in results if r.get("position") == 2), None)
    gap = second.get("gap_to_leader") if second else None

    positions = sorted(
        api.get("position", session_key=key, driver_number=winner), key=lambda r: r["date"]
    )
    grid = positions[0]["position"] if positions else None
    laps = [
        lap
        for lap in api.get("laps", session_key=key, driver_number=winner)
        if lap.get("lap_duration")
    ]
    best = min((lap["lap_duration"] for lap in laps), default=None)
    pits = len(api.get("pit", session_key=key, driver_number=winner))

    rev: list[list[float]] = []
    start = ref.starts_at
    window = {
        "date>": races.iso(start - timedelta(minutes=5)),
        "date<": races.iso(start + timedelta(minutes=12)),
    }
    telemetry = api.get("car_data", session_key=key, driver_number=winner, **window)
    telemetry.sort(key=lambda r: r["date"])
    i = launch(telemetry)
    if i is not None:
        t0 = races.parse_time(telemetry[i]["date"])
        for r in telemetry:
            dt = (races.parse_time(r["date"]) - t0).total_seconds() * 1000
            if -4000 <= dt <= 12000:
                rev.append([round(dt), r["speed"], r["throttle"], r["n_gear"], r["rpm"]])

    first, _, last = (driver.get("full_name") or "").title().partition(" ")
    return {
        "id": ref.id,
        "year": ref.starts_at.year,
        "date": ref.starts_at.date().isoformat(),
        "name": meeting.get("meeting_name") or f"{ref.country} Grand Prix",
        "circuit": ref.circuit,
        "country": ref.country,
        "laps": max((lap["lap_number"] for lap in laps), default=None),
        "winner": {
            "number": winner,
            "code": driver.get("name_acronym"),
            "first": first,
            "last": (driver.get("last_name") or last).upper(),
            "team": driver.get("team_name"),
            "colour": driver.get("team_colour"),
        },
        "car": car_for(ref.starts_at.year, driver.get("team_name") or "", cars),
        "grid": grid,
        "margin_s": gap if isinstance(gap, (int, float)) else None,
        "best_lap_s": round(best, 3) if best else None,
        "pit_stops": pits,
        "rev": rev,
    }


def main() -> int:
    target = Path(sys.argv[1])
    years = range(2023, 2027)
    if "--years" in sys.argv:
        a, _, b = sys.argv[sys.argv.index("--years") + 1].partition("-")
        years = range(int(a), int(b or a) + 1)
    cars = json.loads(CARS.read_text(encoding="utf-8"))["cars"]
    known = (
        {r["id"]: r for r in json.loads(target.read_text(encoding="utf-8"))["races"]}
        if target.exists()
        else {}
    )
    api = OpenF1()
    out = []
    for year in years:
        meetings = {m["meeting_key"]: m for m in api.get("meetings", year=year)}
        for ref in races.list_races(api, year):
            if ref.id in known and known[ref.id].get("rev"):
                out.append(known[ref.id])
                continue
            from datetime import UTC, datetime

            if ref.free_from() > datetime.now(UTC):
                continue  # not run yet, or not historical yet
            e = entry(api, ref, meetings.get(ref.meeting_key, {}), cars)
            if e:
                out.append(e)
                w = e["winner"]
                print(
                    f"{e['id']:24} {w['code']} {e['car'] or '?':6} grid {e['grid']}",
                    f"rev {len(e['rev'])}",
                    flush=True,
                )
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(
                    json.dumps({"races": out}, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8",
                )
    target.write_text(
        json.dumps({"races": out}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"{len(out)} races in {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
