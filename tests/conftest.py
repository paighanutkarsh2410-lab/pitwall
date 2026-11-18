"""A tiny fake OpenF1: two cars, three laps, and the awkward cases the real data has."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import httpx
import pytest

from pitwall.openf1 import OpenF1

T = "2024-11-03T{}+00:00"

SESSIONS = [
    {
        "session_key": 9636,
        "meeting_key": 1249,
        "location": "São Paulo",
        "country_name": "Brazil",
        "circuit_short_name": "Interlagos",
        "date_start": T.format("15:30:00"),
        "is_cancelled": False,
    },
    {
        "session_key": 9590,
        "meeting_key": 1245,
        "location": "Monza",
        "country_name": "Italy",
        "circuit_short_name": "Monza",
        "date_start": "2024-09-01T13:00:00+00:00",
        "is_cancelled": False,
    },
]

TABLES: dict[str, list[dict]] = {
    "meetings": [{"meeting_key": 1249, "meeting_name": "São Paulo Grand Prix"}],
    "drivers": [
        {
            "driver_number": 4,
            "name_acronym": "NOR",
            "full_name": "Lando NORRIS",
            "team_name": "McLaren",
            "team_colour": "FF8000",
            "country_code": "GBR",
        },
        {
            "driver_number": 1,
            "name_acronym": "VER",
            "full_name": "Max VERSTAPPEN",
            "team_name": "Red Bull Racing",
            "team_colour": "3671C6",
            "country_code": "NED",
        },
    ],
    "laps": [
        # VER: a normal lap, a red-flagged lap with no time, then another normal lap.
        {
            "driver_number": 1,
            "lap_number": 1,
            "date_start": T.format("15:50:00.000000"),
            "lap_duration": 100.0,
            "duration_sector_1": 31.5,
            "duration_sector_2": 49.5,
            "duration_sector_3": 19.0,
            "is_pit_out_lap": False,
            "st_speed": 189,
        },
        {
            "driver_number": 1,
            "lap_number": 2,
            "date_start": T.format("15:51:40.000000"),
            "lap_duration": None,
            "duration_sector_1": None,
            "duration_sector_2": None,
            "duration_sector_3": None,
            "is_pit_out_lap": False,
            "st_speed": None,
        },
        {
            "driver_number": 1,
            "lap_number": 3,
            "date_start": T.format("15:53:30.000000"),
            "lap_duration": 90.0,
            "duration_sector_1": 25.0,
            "duration_sector_2": 45.0,
            "duration_sector_3": 20.0,
            "is_pit_out_lap": True,
            "st_speed": 250,
        },
        # NOR: lap 1 has no start time and no duration, as in the real feed.
        {
            "driver_number": 4,
            "lap_number": 1,
            "date_start": None,
            "lap_duration": None,
            "is_pit_out_lap": False,
        },
        {
            "driver_number": 4,
            "lap_number": 2,
            "date_start": T.format("15:51:42.000000"),
            "lap_duration": 88.5,
            "duration_sector_1": 22.0,
            "duration_sector_2": 46.5,
            "duration_sector_3": 20.0,
            "is_pit_out_lap": False,
            "st_speed": 248,
        },
    ],
    "stints": [
        {
            "driver_number": 1,
            "stint_number": 1,
            "lap_start": 1,
            "lap_end": 2,
            "compound": "INTERMEDIATE",
            "tyre_age_at_start": 0,
        },
        {
            "driver_number": 1,
            "stint_number": 2,
            "lap_start": 3,
            "lap_end": None,
            "compound": "WET",
            "tyre_age_at_start": 2,
        },
        {
            "driver_number": 4,
            "stint_number": 1,
            "lap_start": 1,
            "lap_end": 2,
            "compound": "INTERMEDIATE",
            "tyre_age_at_start": 0,
        },
    ],
    "pit": [
        {
            "driver_number": 1,
            "date": T.format("15:53:10.000000"),
            "lap_number": 2,
            "lane_duration": 24.5,
            "pit_duration": 24.5,
            "stop_duration": 2.6,
        }
    ],
    "position": [
        {"driver_number": 1, "date": T.format("15:49:00.000000"), "position": 1},
        {"driver_number": 4, "date": T.format("15:49:00.000000"), "position": 2},
    ],
    "intervals": [
        {
            "driver_number": 1,
            "date": T.format("15:52:10.000000"),
            "gap_to_leader": 0.0,
            "interval": 0.0,
        },
        {
            "driver_number": 4,
            "date": T.format("15:52:10.000000"),
            "gap_to_leader": "+1 LAP",
            "interval": 1.234,
        },
    ],
    "race_control": [
        {
            "date": T.format("15:20:00.000000"),
            "category": "Flag",
            "flag": "GREEN",
            "message": "GREEN LIGHT - PIT EXIT OPEN",
            "scope": "Track",
            "sector": None,
            "lap_number": 1,
            "driver_number": None,
        },
        {
            "date": T.format("15:52:00.000000"),
            "category": "Flag",
            "flag": "RED",
            "message": "RED FLAG",
            "scope": "Track",
            "sector": None,
            "lap_number": 2,
            "driver_number": None,
        },
    ],
    "weather": [
        {
            "date": T.format("15:45:00.000000"),
            "air_temperature": 22.2,
            "track_temperature": 27.3,
            "humidity": 86.0,
            "pressure": 927.4,
            "rainfall": 1,
            "wind_speed": 0.4,
            "wind_direction": 0,
        }
    ],
}

PER_CAR = {
    "car_data": {
        1: [
            {
                "date": T.format("15:50:00.100000"),
                "speed": 207,
                "rpm": 10811,
                "n_gear": 5,
                "throttle": 100,
                "brake": 0,
                "drs": 1,
            },
            {
                "date": T.format("15:50:00.300000"),
                "speed": 212,
                "rpm": 10992,
                "n_gear": 5,
                "throttle": 100,
                "brake": 0,
                "drs": 12,
            },
        ],
        4: [
            {
                "date": T.format("15:50:00.200000"),
                "speed": 150,
                "rpm": 9000,
                "n_gear": 4,
                "throttle": 0,
                "brake": 100,
                "drs": 0,
            },
        ],
    },
    "location": {
        1: [{"date": T.format("15:50:00.150000"), "x": -1436, "y": 1849, "z": 7628}],
        4: [{"date": T.format("15:50:00.250000"), "x": -1200, "y": 1700, "z": 7600}],
    },
}


class FakeOpenF1:
    """Serves the tables above; ``busy`` makes an endpoint answer 429 a few times first."""

    def __init__(self) -> None:
        self.requests: Counter[str] = Counter()
        self.busy: Counter[str] = Counter()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        endpoint = request.url.path.rsplit("/", 1)[-1]
        params = request.url.params
        self.requests[endpoint] += 1
        if self.busy[endpoint] > 0:
            self.busy[endpoint] -= 1
            return httpx.Response(429, json={"detail": "Too many requests"})
        if endpoint == "sessions":
            year = params.get("year")
            rows = [s for s in SESSIONS if s["date_start"].startswith(str(year))]
        elif endpoint in PER_CAR:
            car = int(params["driver_number"])
            rows = [{**r, "driver_number": car} for r in PER_CAR[endpoint].get(car, [])]
        elif endpoint in TABLES:
            rows = TABLES[endpoint]
        else:
            return httpx.Response(404, json={"detail": "No results found."})
        if not rows:
            return httpx.Response(404, json={"detail": "No results found."})
        return httpx.Response(200, json=rows)


@pytest.fixture
def fake() -> FakeOpenF1:
    return FakeOpenF1()


@pytest.fixture
def api(fake: FakeOpenF1) -> OpenF1:
    client = OpenF1(pause=0, transport=httpx.MockTransport(fake), sleep=lambda _: None)
    yield client
    client.close()


@pytest.fixture(autouse=True)
def pitwall_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Every test gets its own race store; nothing touches ~/.pitwall."""
    monkeypatch.setenv("PITWALL_HOME", str(tmp_path / "pitwall"))
    return tmp_path / "pitwall"
