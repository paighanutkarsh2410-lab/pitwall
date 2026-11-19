#!/usr/bin/env bash
# Packs the recorded races and uploads them to the `site-data` release, then redeploys the site.
#
#   ./scripts/publish_site_data.sh            pack site/public/data, upload, run the Site workflow
#
# Record them first (hours, at OpenF1's free rate limit; downloads go wherever PITWALL_HOME points):
#   PITWALL_HOME=D:/PitwallRaces python scripts/record_all.py site/public/data
# Only finished races are packed: a race's manifest.json is written last, so a race still being
# recorded is left out and goes in next time.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/site/public/data"
ARCHIVE="$(mktemp -d)/site-data.tar.gz"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

cd "$DATA"
races=()
for d in */; do
  d="${d%/}"
  [ -f "$d/manifest.json" ] && races+=("$d")
done
[ ${#races[@]} -gt 0 ] || { echo "No recorded races in $DATA" >&2; exit 1; }
tar -czf "$ARCHIVE" "${races[@]}"
echo "Packed ${#races[@]} races: $(du -h "$ARCHIVE" | cut -f1)"

if gh release view site-data --repo "$REPO" >/dev/null 2>&1; then
  gh release upload site-data "$ARCHIVE" --repo "$REPO" --clobber
else
  gh release create site-data "$ARCHIVE" --repo "$REPO" --title "Site data: recorded races" \
    --notes "Race recordings for the public site's pit wall, made by scripts/record_race.py from OpenF1 data. Not a software release; the Site workflow downloads this archive."
fi
gh workflow run site.yml --repo "$REPO"
echo "Uploaded; the Site workflow is redeploying."
