# Pitwall

**Real race telemetry, streamed like it's live, on a platform that keeps itself healthy.**

Pitwall replays real Grands Prix (car telemetry, positions, lap times, tyres, pit stops, race
control and weather) as a live event stream, and is growing into a Kubernetes platform that
carries that stream from a trackside site to a factory site, measures its own SLOs, rolls back
bad deploys by itself and survives the failures thrown at it. See [the plan](docs/plan.md).

> Unofficial personal project. Not associated with Formula 1, the FIA or any team. Race data
> comes from [OpenF1](https://openf1.org), a free, unofficial API.

## Status

| Phase | |
|---|---|
| 0. Foundations and data: race download, replayer, event format, CI | ✅ |
| 1. Pipeline on one cluster: Redpanda, services, pit-wall screen, Argo CD | next |
| 2. Observability and SLOs | |
| 3. Self-healing deploys (Argo Rollouts canaries) | |
| 4. Trackside and factory, with a link you can cut | |
| 5. Race weekend at scale: autoscaling, load tests, chaos GameDays | |
| 6. Polish, demo video, public demo | |

## Try the replayer

Python 3.12 or newer:

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e .

pitwall races 2024                 # the year's races
pitwall fetch 2024-sao-paulo       # download once: about 6 minutes
pitwall replay 2024-sao-paulo --speed 10
```

```text
-0:51:55.5  RACE  São Paulo Grand Prix · Interlagos · 20 drivers · 69 laps
 0:19:57.5  RC         SESSION STARTED
 0:19:57.5  TYRE  VER  stint 1  INTERMEDIATE (new) from lap 1
 0:19:58.0  RC          GREEN  GREEN LIGHT - PIT EXIT OPEN
 ...
 0:54:31.9  PIT   LEC  lap 24  2.6 s stopped, 24.6 s in the pit lane
 1:02:01.0  LAP   VER  lap 29   1:45.014   S1 25.007  S2 55.169  S3 24.838
 1:07:22.0  RC          RED  RED FLAG
```

Times count from the scheduled start; rain delayed this one by 20 minutes. The whole race is
1.86 million events (a 21 MB file); `--speed 0` replays all of it in about 20 seconds.

Useful options:

| | |
|---|---|
| `--speed 10` | Ten times real time; `0` sends everything as fast as possible |
| `--from-lap 30` | Start at lap 30; `0` includes the build-up before the start |
| `--types lap,pit,race.control` | Only these event types (prefixes work: `car` = telemetry and positions) |
| `--cars 1,4` | Only these cars (race-wide events are kept) |
| `--format jsonl` | One JSON event per line, for piping into other tools |

The pretty view hides the high-rate events (telemetry, positions, gaps); name them with
`--types` to see them. `pitwall info RACE` summarises a download and `pitwall validate RACE`
checks every event against the schema.

Races are stored in `~/.pitwall/races` (`PITWALL_HOME` moves them). The replayer also ships as a
container image:

```bash
docker run --rm -v ~/.pitwall:/data ghcr.io/paighanutkarsh2410-lab/pitwall-replayer:main replay 2024-sao-paulo --speed 10
```

## The event format

Every event shares one envelope (`v`, `type`, `race`, `seq`, `t`, `at`, `car`, `data`) and
eleven types, from `car.telemetry` to `race.control`. `t` counts milliseconds from the scheduled
start, so every replay and every consumer agrees on race time at any speed. Details in
[docs/events.md](docs/events.md); the JSON Schema is [schemas/events.v1.json](schemas/events.v1.json).

## Team logos

Logos are trademarks, so none are in this repository. To see them locally, put them in
`assets/private/` (ignored by git); without them, Pitwall shows badges in each team's colour.

## Layout

| Path | |
|---|---|
| `src/pitwall/` | Race download (`openf1.py`, `race.py`), replayer (`replay.py`), event format (`events.py`), CLI |
| `schemas/` | Generated JSON Schema for events |
| `tests/` | Unit tests against a fake OpenF1, no network |
| `docs/` | The plan and the event format |
| `Dockerfile` | The replayer image (non-root) |

## Develop

```bash
pip install -e ".[dev]"
ruff check src tests && ruff format --check src tests
pytest
```

CI lints, tests, scans the source and the image with Trivy, and on `main` pushes the image to
GHCR signed with cosign (keyless).
