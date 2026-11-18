import json

import pytest

from pitwall import race as races
from pitwall.cli import lap_time, main, race_clock


@pytest.fixture(autouse=True)
def downloaded(api):
    races.fetch(api, "2024-sao-paulo", progress=lambda _: None)


def test_info_summarises_the_race(capsys):
    assert main(["info", "2024-sao-paulo"]) == 0
    out = capsys.readouterr().out
    assert "São Paulo Grand Prix · Interlagos, Brazil · 2024" in out
    assert "Lap 1 starts at 0:20:00.0 after the scheduled start" in out


def test_jsonl_replay_streams_the_chosen_events(capsys):
    assert (
        main(
            [
                "replay",
                "2024-sao-paulo",
                "--speed",
                "0",
                "--format",
                "jsonl",
                "--types",
                "lap.completed,pit",
            ]
        )
        == 0
    )
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [e["type"] for e in lines] == [
        "session.info",
        "lap.completed",  # VER lap 1
        "lap.completed",  # NOR lap 1 (ends when his lap 2 starts)
        "pit.stop",  # VER, under the red flag
        "lap.completed",  # NOR lap 2
        "lap.completed",  # VER lap 2 (no time: red flag)
        "lap.completed",  # VER lap 3
    ]


def test_pretty_replay_reads_like_a_timing_screen(capsys):
    assert main(["replay", "2024-sao-paulo", "--speed", "0", "--from-lap", "0"]) == 0
    out = capsys.readouterr().out
    assert "São Paulo Grand Prix · Interlagos · 2 drivers · 3 laps" in out
    assert "RED FLAG" in out
    assert "VER  lap  1   1:40.000" in out
    assert "2.6 s stopped, 24.5 s in the pit lane" in out
    assert "TEL" not in out  # telemetry is opt-in in pretty mode


def test_from_lap_must_exist(capsys):
    with pytest.raises(SystemExit, match="no lap 9; this race has laps 1 to 3"):
        main(["replay", "2024-sao-paulo", "--from-lap", "9"])


def test_validate_passes_a_good_race(capsys):
    assert main(["validate", "2024-sao-paulo"]) == 0
    assert "all valid" in capsys.readouterr().out


def test_an_unknown_race_is_a_friendly_error(capsys):
    assert main(["info", "2023-nowhere"]) == 1
    assert "pitwall fetch 2023-nowhere" in capsys.readouterr().err


def test_clock_and_lap_formats():
    assert race_clock(-600_000) == "-0:10:00.0"
    assert race_clock(3_725_400) == " 1:02:05.4"
    assert lap_time(81_334) == "1:21.334"
    assert lap_time(2_600) == "2.600"
    assert lap_time(None) == "-"
