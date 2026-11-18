# Event format, version 1

Every service in Pitwall speaks one format: JSON objects with a common envelope and a typed
`data` payload. The models live in [`src/pitwall/events.py`](../src/pitwall/events.py); the JSON
Schema in [`schemas/events.v1.json`](../schemas/events.v1.json) is generated from them
(`pitwall schema --out schemas/events.v1.json`), and CI fails if the two drift apart.

## Envelope

```json
{"v": 1, "type": "pit.stop", "race": "2024-sao-paulo", "seq": 812345, "t": 3190000,
 "at": "2024-11-03T16:23:10.000Z", "car": 1, "data": {"lap": 24, "pit_lane_ms": 24573, "stop_ms": 2600}}
```

| Field | Meaning |
|---|---|
| `v` | Format version, `1`. A breaking change means a new version, not an edit |
| `type` | One of the types below |
| `race` | Race id, `YEAR-place` |
| `seq` | 0, 1, 2… across the whole race; a consumer can spot a missing event |
| `t` | Milliseconds since the **scheduled** start; negative before it. Replays and consumers agree on time whatever the replay speed |
| `at` | When the data was recorded, UTC |
| `car` | Car number, or `null` for race-wide events |

## Types

| Type | Per | About | `data` |
|---|---|---|---|
| `session.info` | race | first event of every replay | race name, circuit, country, scheduled start, laps, drivers (number, code, name, team, team colour) |
| `car.telemetry` | car | ~4 per second | `speed` km/h, `rpm`, `gear`, `throttle` %, `brake` (0/100), `drs` code (10, 12, 14 = open) |
| `car.position` | car | ~4 per second | `x`, `y`, `z` on the circuit map |
| `lap.started` | car | each lap | `lap` |
| `lap.completed` | car | each lap | `lap`, `lap_time_ms`, `sectors_ms` [3], `pit_out_lap`, `speed_trap_kph` |
| `tyre.stint` | car | each stint | `stint`, `compound`, `lap_start`, `lap_end`, `tyre_age` |
| `pit.stop` | car | each stop | `lap`, `pit_lane_ms`, `stop_ms` |
| `race.position` | car | on change | `position` |
| `race.interval` | car | every few seconds | `gap_to_leader`, `interval` (seconds, or text such as `"+1 LAP"`) |
| `race.control` | race or car | as issued | `category`, `message`, `flag`, `scope`, `sector`, `lap` |
| `weather` | race | ~every minute | `air_c`, `track_c`, `humidity`, `pressure_mbar`, `rainfall`, `wind_ms`, `wind_dir` |

## How OpenF1's tables become events

- **Laps** become two events: `lap.started` when the car crosses the line and `lap.completed`
  when it crosses again. A lap with no recorded time (a red flag, a retirement) still completes
  when the next lap starts, with `lap_time_ms: null`.
- **Stints** carry lap numbers, not times, so a stint is announced when its first lap starts.
- **Time zero** is the scheduled start. At São Paulo 2024, rain delayed the start and lap 1
  began 20 minutes later; `pitwall replay` starts at lap 1 by default, and `--from-lap 0` plays
  the build-up too.
- **The session.info header** always opens a replay, whatever the starting lap or filter, so a
  consumer joining mid-race still knows who is who.
