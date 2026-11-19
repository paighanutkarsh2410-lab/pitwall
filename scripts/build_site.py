"""Assembles the static site in site/dist from its parts. Copies only; never deletes.

    python scripts/build_site.py

  site/builds/race/          ->  site/dist/                 the scroll-driven race (tab 1)
  web/dist (recording build) ->  site/dist/pitwall/         the pit-wall screen (tab 2)
  site/builds/engineering/   ->  site/dist/engineering/     how it is built (tab 3)
  site/public/data/          ->  site/dist/data/            written by scripts/record_race.py

The pit-wall screen is built with `npm run build:site` in web/ (a recording, not a WebSocket).
"""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
DIST = SITE / "dist"
PRIVATE = shutil.ignore_patterns("BRIEF.md", "node_modules", "lab", "*.map")


def copy(source: Path, target: Path) -> None:
    if not source.exists():
        print(f"  skipped {source.relative_to(ROOT)} (not there yet)")
        return
    shutil.copytree(source, target, dirs_exist_ok=True, ignore=PRIVATE)
    print(f"  {source.relative_to(ROOT)} -> {target.relative_to(ROOT)}")


def main() -> int:
    DIST.mkdir(parents=True, exist_ok=True)
    copy(SITE / "builds" / "race", DIST)
    copy(SITE / "builds" / "engineering", DIST / "engineering")
    copy(ROOT / "web" / "dist-site", DIST / "pitwall")
    copy(SITE / "public" / "data", DIST / "data")
    (DIST / ".nojekyll").write_text("")  # GitHub Pages: serve files as they are
    print(f"Site ready in {DIST.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
