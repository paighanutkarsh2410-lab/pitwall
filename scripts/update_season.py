"""Adds each race to the public site once it has been run. .github/workflows/season.yml runs this.

    python scripts/update_season.py --data out/data [--redo 2026-las-vegas]

Reads the season's calendar from OpenF1 and, for every race that has finished and isn't in the
home page's catalogue yet: downloads it, records it for the pit wall, checks the recording is
whole, and only then adds it to the catalogue. Races still to come are listed under "upcoming".
A race whose data isn't complete yet is left for the next run. Results can change after the flag
(penalties), so a race's catalogue entry is read again for three days.

OpenF1 answers nobody while a session is live, and timing data arrives in its own time, so "not
yet" is a normal outcome. It is reported as a failure only when a race is a day overdue.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import shutil
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

from race_catalogue import CARS, CATALOGUE, entry, read, write  # noqa: E402
from record_race import record  # noqa: E402

from pitwall import race as races  # noqa: E402
from pitwall.openf1 import OpenF1, OpenF1Error  # noqa: E402

SEASON = 2026
SETTLES = timedelta(days=3)  # results may still change
OVERDUE = timedelta(days=1)  # a finished race should be on the site by then


def upcoming(refs: list[races.RaceRef], names: dict[int, str], known: set[str]) -> list[dict]:
    """The races not in the catalogue yet, as the home page lists them."""
    return [
        {
            "id": r.id,
            "year": r.starts_at.year,
            "date": r.starts_at.date().isoformat(),
            "starts_at": races.iso(r.starts_at),
            "name": names.get(r.meeting_key) or f"{r.country} Grand Prix",
            "circuit": r.circuit,
            "country": r.country,
        }
        for r in refs
        if r.id not in known
    ]


def problem(folder: Path, winner: int, laps: int) -> str | None:
    """Why this recording isn't whole, or None if it is: the winner's laps, the circuit, and the
    winner's telemetry for nearly every minute of the race."""
    story = json.loads((folder / "story.json").read_text("utf-8"))
    manifest = json.loads((folder / "manifest.json").read_text("utf-8"))
    if len(story["laps"]) < laps:
        return f"{len(story['laps'])} of {laps} laps"
    if not manifest["track"]:
        return "no circuit outline"
    finish = story["laps"][-1]["t"]
    minutes = [c for c in manifest["chunks"] if manifest["start_t"] <= c["t0"] < finish]
    have = 0
    for c in minutes:
        with gzip.open(folder / c["file"], "rt", encoding="utf-8") as f:
            have += bool(json.load(f)["telemetry"].get(str(winner)))
    # Not every minute: a red flag parks the cars.
    if not minutes or have < len(minutes) * 0.7:
        return f"the winner's telemetry covers {have} of {len(minutes)} minutes"
    return None


def winner_of(api: OpenF1, ref: races.RaceRef) -> tuple[int, int] | None:
    """The winner's number and laps, once the result is out."""
    rows = api.get("session_result", session_key=ref.session_key)
    first = next((r for r in rows if r.get("position") == 1), None)
    if not first or not first.get("number_of_laps"):
        return None
    return first["driver_number"], first["number_of_laps"]


def add(api: OpenF1, ref: races.RaceRef, meeting: dict, cars: list[dict], data: Path) -> dict | str:
    """Records one finished race. Its catalogue entry, or why it has to wait."""
    won = winner_of(api, ref)
    made = entry(api, ref, meeting, cars) if won else None
    if won is None or made is None:
        return "no result yet"
    if not made["rev"] and datetime.now(UTC) - ref.free_from() < OVERDUE:
        return "no launch telemetry yet"
    target = data / ref.id
    try:
        races.fetch(api, ref.id, progress=lambda _: None, force=True)
        record(ref.id, data)
        why = problem(target, *won)
    except (OpenF1Error, LookupError):
        shutil.rmtree(target, ignore_errors=True)
        raise
    if why:
        shutil.rmtree(target, ignore_errors=True)
        return f"incomplete: {why}"
    return made


def run(api: OpenF1, data: Path, redo: str | None) -> int:
    now = datetime.now(UTC)
    catalogue = read(CATALOGUE)
    known = {r["id"]: r for r in catalogue["races"]}
    cars = json.loads(CARS.read_text("utf-8"))["cars"]
    added: list[str] = []
    failed = False
    try:
        refs = races.list_races(api, SEASON)
        meetings = {m["meeting_key"]: m for m in api.get("meetings", year=SEASON)}
        if not refs:
            raise OpenF1Error("the calendar came back empty")
        for ref in refs:
            if ref.free_from() > now:
                continue
            meeting = meetings.get(ref.meeting_key, {})
            if ref.id == redo or ref.id not in known:
                try:
                    got = add(api, ref, meeting, cars, data)
                except (OpenF1Error, LookupError) as error:
                    got = str(error)
                if isinstance(got, str):
                    print(f"{ref.id}: waiting ({got})", flush=True)
                    failed = failed or ref.id == redo or now - ref.free_from() > OVERDUE
                    continue
                known[ref.id] = got
                added.append(ref.id)
                print(f"{ref.id}: recorded, won by {got['winner']['code']}", flush=True)
            elif now - ref.starts_at < SETTLES:
                again = entry(api, ref, meeting, cars)
                if again and again["rev"] and again != known[ref.id]:
                    known[ref.id] = again
                    print(f"{ref.id}: result updated", flush=True)
        names = {k: m.get("meeting_name", "") for k, m in meetings.items()}
        catalogue["upcoming"] = upcoming(refs, names, set(known))
    except OpenF1Error as error:
        # Locked (a live session) or down. Whatever was added before this still counts.
        print(f"::warning::OpenF1: {error}. Trying again on the next run.", flush=True)
        starts = [races.parse_time(u["starts_at"]) for u in catalogue.get("upcoming", [])]
        failed = any(now - t > OVERDUE + timedelta(hours=4) for t in starts)
    catalogue["races"] = list(known.values())
    catalogue["upcoming"] = [u for u in catalogue.get("upcoming", []) if u["id"] not in known]
    write(CATALOGUE, catalogue)
    if path := os.environ.get("GITHUB_OUTPUT"):
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"added={' '.join(added)}\nfailed={str(failed).lower()}\n")
    left = [u["id"] for u in catalogue["upcoming"]]
    print(f"Recorded {added or 'nothing'}; still to come: {left or 'none'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, required=True, help="where recordings are written")
    parser.add_argument("--redo", help="record this race again even if it is on the site")
    args = parser.parse_args()
    if args.redo and not races.RACE_ID.fullmatch(args.redo):
        parser.error("--redo takes a race id such as 2026-las-vegas")
    args.data.mkdir(parents=True, exist_ok=True)
    with OpenF1() as api:
        return run(api, args.data, args.redo or None)


if __name__ == "__main__":
    sys.exit(main())
