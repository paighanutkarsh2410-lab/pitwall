"""Pitwall's event format, version 1: the contract between the replayer and every service.

Every event is one JSON object:

    {"v": 1, "type": "lap.completed", "race": "2024-sao-paulo", "seq": 812,
     "t": 754123, "at": "2024-11-03T15:42:34.123Z", "car": 1, "data": {...}}

- ``t`` is milliseconds since the session's scheduled start (negative before it), so a replay
  can run at any speed and two replays of one race always agree.
- ``at`` is the real wall-clock time the data was recorded, in UTC.
- ``car`` is the car (driver) number, or null for race-wide events.
- ``seq`` increases by one per event across the whole race: consumers can detect gaps.

The JSON Schema in ``schemas/events.v1.json`` is generated from these models
(``pitwall schema``); a test fails if the two drift apart.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

SCHEMA_VERSION = 1


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---- Payloads ---------------------------------------------------------------------------------


class Driver(_Model):
    number: int
    code: str = Field(description="Three-letter code, e.g. VER")
    name: str
    team: str
    colour: str | None = Field(None, description="Team colour as hex RGB, no #")
    country: str | None = None


class SessionInfo(_Model):
    race_id: str
    name: str = Field(description="e.g. São Paulo Grand Prix")
    circuit: str
    location: str
    country: str
    year: int
    starts_at: str = Field(description="Scheduled start, UTC; t=0")
    laps: int | None = Field(None, description="Laps the leader completed")
    drivers: list[Driver]


class CarTelemetry(_Model):
    speed: int = Field(description="km/h")
    rpm: int
    gear: int
    throttle: int = Field(description="Percent")
    brake: int = Field(description="0 or 100")
    drs: int = Field(description="Raw DRS state code; 10, 12 and 14 mean open")


class CarPosition(_Model):
    x: int
    y: int
    z: int


class LapStarted(_Model):
    lap: int


class LapCompleted(_Model):
    lap: int
    lap_time_ms: int | None
    sectors_ms: list[int | None] = Field(description="Sector 1, 2 and 3 times")
    pit_out_lap: bool
    speed_trap_kph: int | None = None


class TyreStint(_Model):
    stint: int
    compound: str = Field(description="SOFT, MEDIUM, HARD, INTERMEDIATE or WET")
    lap_start: int
    lap_end: int | None
    tyre_age: int = Field(description="Laps on the tyres when the stint started")


class PitStop(_Model):
    lap: int
    pit_lane_ms: int | None = Field(description="Time in the pit lane, entry to exit")
    stop_ms: int | None = Field(None, description="Time stationary in the box")


class RacePosition(_Model):
    position: int


class Interval(_Model):
    gap_to_leader: float | str | None = Field(description="Seconds, or text such as '+1 LAP'")
    interval: float | str | None = Field(description="To the car ahead; seconds or text")


class RaceControl(_Model):
    category: str
    message: str
    flag: str | None = None
    scope: str | None = None
    sector: int | None = None
    lap: int | None = None


class Weather(_Model):
    air_c: float
    track_c: float
    humidity: float
    pressure_mbar: float
    rainfall: bool
    wind_ms: float
    wind_dir: int


# ---- Envelopes --------------------------------------------------------------------------------


class _Envelope(_Model):
    v: Literal[1] = SCHEMA_VERSION
    race: str
    seq: int = Field(ge=0)
    t: int = Field(description="Milliseconds since the scheduled start")
    at: str = Field(description="UTC time the data was recorded")
    car: int | None = None


class SessionInfoEvent(_Envelope):
    type: Literal["session.info"]
    data: SessionInfo


class CarTelemetryEvent(_Envelope):
    type: Literal["car.telemetry"]
    data: CarTelemetry


class CarPositionEvent(_Envelope):
    type: Literal["car.position"]
    data: CarPosition


class LapStartedEvent(_Envelope):
    type: Literal["lap.started"]
    data: LapStarted


class LapCompletedEvent(_Envelope):
    type: Literal["lap.completed"]
    data: LapCompleted


class TyreStintEvent(_Envelope):
    type: Literal["tyre.stint"]
    data: TyreStint


class PitStopEvent(_Envelope):
    type: Literal["pit.stop"]
    data: PitStop


class RacePositionEvent(_Envelope):
    type: Literal["race.position"]
    data: RacePosition


class IntervalEvent(_Envelope):
    type: Literal["race.interval"]
    data: Interval


class RaceControlEvent(_Envelope):
    type: Literal["race.control"]
    data: RaceControl


class WeatherEvent(_Envelope):
    type: Literal["weather"]
    data: Weather


Event = Annotated[
    SessionInfoEvent
    | CarTelemetryEvent
    | CarPositionEvent
    | LapStartedEvent
    | LapCompletedEvent
    | TyreStintEvent
    | PitStopEvent
    | RacePositionEvent
    | IntervalEvent
    | RaceControlEvent
    | WeatherEvent,
    Field(discriminator="type"),
]

EVENT_TYPES: tuple[str, ...] = (
    "session.info",
    "car.telemetry",
    "car.position",
    "lap.started",
    "lap.completed",
    "tyre.stint",
    "pit.stop",
    "race.position",
    "race.interval",
    "race.control",
    "weather",
)

event_adapter: TypeAdapter[Event] = TypeAdapter(Event)


def validate(event: dict) -> Event:
    """Checks one event against the schema; raises pydantic.ValidationError if it doesn't fit."""
    return event_adapter.validate_python(event)


def json_schema() -> dict:
    schema = event_adapter.json_schema()
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://github.com/paighanutkarsh2410-lab/pitwall/schemas/events.v1.json",
        "title": "Pitwall event, version 1",
        **schema,
    }
