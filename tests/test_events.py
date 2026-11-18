import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from pitwall.events import EVENT_TYPES, json_schema, validate

SCHEMA = Path(__file__).parent.parent / "schemas" / "events.v1.json"


def test_the_published_schema_matches_the_code():
    published = json.loads(SCHEMA.read_text("utf-8"))
    assert published == json_schema(), "Run: pitwall schema --out schemas/events.v1.json"


def test_every_event_type_is_in_the_schema():
    mapping = json_schema()["discriminator"]["mapping"]
    assert set(mapping) == set(EVENT_TYPES)


def base(**changes) -> dict:
    event = {
        "v": 1,
        "type": "pit.stop",
        "race": "2024-sao-paulo",
        "seq": 3,
        "t": 1000,
        "at": "2024-11-03T15:53:10.000Z",
        "car": 1,
        "data": {"lap": 2, "pit_lane_ms": 24500, "stop_ms": 2600},
    }
    return {**event, **changes}


def test_a_valid_event_passes():
    assert validate(base()).data.stop_ms == 2600


@pytest.mark.parametrize(
    "bad",
    [
        {"type": "car.teleport"},
        {"v": 2},
        {"seq": -1},
        {"data": {"lap": 2, "pit_lane_ms": 24500, "surprise": True}},
        {"data": {"lap": "two", "pit_lane_ms": 24500}},
    ],
)
def test_events_that_break_the_contract_are_rejected(bad):
    with pytest.raises(ValidationError):
        validate(base(**bad))
