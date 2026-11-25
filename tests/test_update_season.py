"""The after-race update: what it lists, what it refuses, and that it never loses a race."""

import gzip
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import race_catalogue
import update_season as season

from pitwall.openf1 import OpenF1Error
from pitwall.race import RaceRef


def ref(race_id: str, hours_ago: float, key: int = 1) -> RaceRef:
    start = datetime.now(UTC) - timedelta(hours=hours_ago)
    return RaceRef(race_id, key, key, "L", "C", "Circuit", start, start + timedelta(hours=2))


def entry(race_id: str, date: str = "2024-01-01") -> dict:
    return {"id": race_id, "date": date, "rev": [[0]], "winner": {"code": "VER"}}


class Api:
    def get(self, endpoint, **_):
        return [{"meeting_key": 2, "meeting_name": "Qatar Grand Prix"}]


@pytest.fixture
def catalogue(tmp_path, monkeypatch):
    path = tmp_path / "races.json"
    path.write_text(json.dumps({"races": [entry("2024-old")]}), "utf-8")
    monkeypatch.setattr(season, "CATALOGUE", path)
    monkeypatch.setenv("GITHUB_OUTPUT", str(tmp_path / "output"))
    return path


def test_a_finished_race_moves_from_upcoming_to_the_races(catalogue, tmp_path, monkeypatch):
    refs = [ref("2026-done", 5), ref("2026-next", -48, 2)]
    monkeypatch.setattr(season.races, "list_races", lambda *_: refs)
    monkeypatch.setattr(season, "add", lambda api, r, *_: entry(r.id, "2026-11-29"))
    season.run(Api(), tmp_path, None)
    saved = json.loads(catalogue.read_text("utf-8"))
    assert [r["id"] for r in saved["races"]] == ["2024-old", "2026-done"]
    assert [(u["id"], u["name"]) for u in saved["upcoming"]] == [("2026-next", "Qatar Grand Prix")]
    assert "added=2026-done\nfailed=false" in (tmp_path / "output").read_text()


@pytest.mark.parametrize(("hours_ago", "failed"), [(4, "false"), (40, "true")])
def test_incomplete_data_waits_and_is_a_failure_only_after_a_day(
    catalogue, tmp_path, monkeypatch, hours_ago, failed
):
    monkeypatch.setattr(season.races, "list_races", lambda *_: [ref("2026-done", hours_ago)])
    monkeypatch.setattr(season, "add", lambda *_: "no result yet")
    season.run(Api(), tmp_path, None)
    saved = json.loads(catalogue.read_text("utf-8"))
    assert [r["id"] for r in saved["races"]] == ["2024-old"]
    assert [u["id"] for u in saved["upcoming"]] == ["2026-done"]
    assert f"added=\nfailed={failed}" in (tmp_path / "output").read_text()


def test_a_locked_openf1_changes_nothing(catalogue, tmp_path, monkeypatch):
    def locked(*_):
        raise OpenF1Error("/sessions failed: HTTP 401")

    monkeypatch.setattr(season.races, "list_races", locked)
    assert season.run(Api(), tmp_path, None) == 0
    assert [r["id"] for r in json.loads(catalogue.read_text("utf-8"))["races"]] == ["2024-old"]
    assert "failed=false" in (tmp_path / "output").read_text()


def test_updating_one_season_keeps_the_others(catalogue, monkeypatch):
    monkeypatch.setattr(race_catalogue, "OpenF1", Api)
    monkeypatch.setattr(race_catalogue.races, "list_races", lambda *_: [ref("2026-done", 5)])
    monkeypatch.setattr(race_catalogue, "entry", lambda *_: None)
    monkeypatch.setattr(sys, "argv", ["race_catalogue.py", str(catalogue), "--years", "2026"])
    race_catalogue.main()
    assert [r["id"] for r in json.loads(catalogue.read_text("utf-8"))["races"]] == ["2024-old"]


def recording(folder: Path, laps: int, with_telemetry: int) -> Path:
    chunks = [{"file": f"c{i}.json.gz", "t0": i * 60_000} for i in range(10)]
    for i, c in enumerate(chunks):
        body = {"telemetry": {"3": [[1]]} if i < with_telemetry else {}}
        (folder / c["file"]).write_bytes(gzip.compress(json.dumps(body).encode()))
    manifest = {"track": {"points": []}, "start_t": 0, "chunks": chunks}
    (folder / "manifest.json").write_text(json.dumps(manifest))
    (folder / "story.json").write_text(json.dumps({"laps": [{"t": 600_000}] * laps}))
    return folder


@pytest.mark.parametrize(
    ("laps", "minutes", "why"),
    [(50, 10, None), (31, 10, "31 of 50 laps"), (50, 3, "covers 3 of 10 minutes")],
)
def test_only_a_whole_recording_passes(tmp_path, laps, minutes, why):
    found = season.problem(recording(tmp_path, laps, minutes), 3, 50)
    assert found is None if why is None else why in found
