"""Downloads and records every race in the home page's catalogue, for the pit-wall tab.

    PITWALL_HOME=D:/PitwallRaces python scripts/record_all.py site/public/data

For each race in site/builds/home/public/races.json: download it from OpenF1 if it isn't on disk
yet (a few minutes each, at OpenF1's free rate limit), then record it through Pitwall's models
with scripts/record_race.py. A race already recorded is skipped, so this can be stopped and run
again. Downloads are about 40 MB a race, so point PITWALL_HOME at a roomy drive.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

from record_race import record  # noqa: E402

from pitwall import race as races  # noqa: E402
from pitwall.openf1 import OpenF1  # noqa: E402

CATALOGUE = ROOT / "site" / "builds" / "home" / "public" / "races.json"


def recorded(out: Path, race_id: str) -> bool:
    manifest = out / race_id / "manifest.json"
    if not manifest.exists():
        return False
    chunks = json.loads(manifest.read_text(encoding="utf-8")).get("chunks", [])
    return bool(chunks) and chunks[0]["file"].endswith(".gz")


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "site" / "public" / "data")
    catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8"))["races"]
    api = OpenF1()
    todo = [r["id"] for r in catalogue if not recorded(out, r["id"])]
    print(f"{len(catalogue)} races, {len(todo)} to record; downloads in {races.home()}", flush=True)
    for n, race_id in enumerate(todo, 1):
        started = time.monotonic()
        try:
            races.fetch(api, race_id, progress=lambda _: None)
            record(race_id, out)
        except Exception as error:  # one bad race shouldn't stop the rest
            print(f"[{n}/{len(todo)}] {race_id}: FAILED {error}", flush=True)
            continue
        print(f"[{n}/{len(todo)}] {race_id}: {time.monotonic() - started:.0f} s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
