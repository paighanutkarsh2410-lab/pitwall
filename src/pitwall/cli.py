"""pitwall: download real races and replay them as a live event stream.

pitwall races 2024                       races OpenF1 has for a year
pitwall fetch 2024-sao-paulo             download a race once (about 300 MB, a few minutes)
pitwall info 2024-sao-paulo              what's in a downloaded race
pitwall replay 2024-sao-paulo --speed 10 stream it to this terminal
pitwall replay 2024-sao-paulo --format jsonl --types lap,pit | ...
pitwall validate 2024-sao-paulo          check every event against the schema
pitwall schema                           the event JSON Schema
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import ClassVar

from pydantic import ValidationError

from pitwall import race as races
from pitwall.events import EVENT_TYPES, json_schema, validate
from pitwall.openf1 import OpenF1, OpenF1Error
from pitwall.replay import Filter, Stats, replay

# Shown by default in pretty output; telemetry and positions are many per second per car.
QUIET = ("car.telemetry", "car.position", "race.interval", "lap.started")


# ---- Pretty output ----------------------------------------------------------------------------


class Painter:
    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    def __call__(self, text: str, code: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.enabled else text

    def team(self, text: str, colour: str | None) -> str:
        if not (self.enabled and colour and len(colour) == 6):
            return text
        r, g, b = (int(colour[i : i + 2], 16) for i in (0, 2, 4))
        return f"\033[1;38;2;{r};{g};{b}m{text}\033[0m"


def race_clock(t: int) -> str:
    sign = "-" if t < 0 else " "
    seconds = abs(t) / 1000
    h, rest = divmod(seconds, 3600)
    m, s = divmod(rest, 60)
    return f"{sign}{int(h)}:{int(m):02d}:{s:04.1f}"


def lap_time(ms: int | None) -> str:
    if ms is None:
        return "-"
    m, s = divmod(ms / 1000, 60)
    return f"{int(m)}:{s:06.3f}" if m else f"{s:.3f}"


def gap(value: float | str | None) -> str:
    if value is None:
        return "-"
    return value if isinstance(value, str) else f"+{value:.3f}"


class Pretty:
    LABELS: ClassVar[dict[str, tuple[str, str]]] = {
        "session.info": ("RACE", "1;37"),
        "car.telemetry": ("TEL", "36"),
        "car.position": ("XYZ", "2;36"),
        "lap.started": ("LAP", "2;37"),
        "lap.completed": ("LAP", "37"),
        "tyre.stint": ("TYRE", "33"),
        "pit.stop": ("PIT", "1;33"),
        "race.position": ("POS", "35"),
        "race.interval": ("GAP", "2;35"),
        "race.control": ("RC", "1;34"),
        "weather": ("WX", "34"),
    }
    FLAGS: ClassVar[dict[str, str]] = {
        "RED": "1;41;37",
        "YELLOW": "1;43;30",
        "DOUBLE YELLOW": "1;43;30",
        "GREEN": "1;42;30",
    }

    def __init__(self, paint: Painter) -> None:
        self.paint = paint
        self.drivers: dict[int, dict] = {}

    def driver(self, car: int | None) -> str:
        if car is None:
            return "   "
        d = self.drivers.get(car)
        return self.paint.team(d["code"], d.get("colour")) if d else f"#{car:<2}"

    def line(self, e: dict) -> str:
        label, colour = self.LABELS.get(e["type"], (e["type"], "37"))
        head = f"{self.paint(race_clock(e['t']), '2')}  {self.paint(f'{label:<4}', colour)}"
        d = e["data"]
        match e["type"]:
            case "session.info":
                self.drivers = {x["number"]: x for x in d["drivers"]}
                laps = f" · {d['laps']} laps" if d.get("laps") else ""
                body = (
                    f"{self.paint(d['name'], '1')} · {d['circuit']} · "
                    f"{len(d['drivers'])} drivers{laps}"
                )
                return f"{head}  {body}"
            case "car.telemetry":
                drs = "  DRS" if d["drs"] in (10, 12, 14) else ""
                brake = "  BRAKE" if d["brake"] else ""
                body = (
                    f"{d['speed']:>3} km/h  gear {d['gear']}  "
                    f"throttle {d['throttle']:>3}%  {d['rpm']:>5} rpm{brake}{drs}"
                )
            case "car.position":
                body = f"x {d['x']:>6}  y {d['y']:>6}  z {d['z']:>5}"
            case "lap.started":
                body = f"starts lap {d['lap']}"
            case "lap.completed":
                sectors = "  ".join(
                    f"S{i} {lap_time(ms)}" for i, ms in enumerate(d["sectors_ms"], 1)
                )
                out = "  (out lap)" if d["pit_out_lap"] else ""
                body = f"lap {d['lap']:>2}  {lap_time(d['lap_time_ms']):>9}   {sectors}{out}"
            case "tyre.stint":
                age = "new" if d["tyre_age"] == 0 else f"{d['tyre_age']} laps old"
                body = f"stint {d['stint']}  {d['compound']} ({age}) from lap {d['lap_start']}"
            case "pit.stop":
                stop = f"{d['stop_ms'] / 1000:.1f} s stopped, " if d.get("stop_ms") else ""
                lane = (
                    f"{d['pit_lane_ms'] / 1000:.1f} s in the pit lane" if d["pit_lane_ms"] else ""
                )
                body = f"lap {d['lap']}  {stop}{lane}"
            case "race.position":
                body = f"P{d['position']}"
            case "race.interval":
                body = f"{gap(d['interval'])} to car ahead, {gap(d['gap_to_leader'])} to leader"
            case "race.control":
                flag = d.get("flag")
                badge = (
                    f"{self.paint(f' {flag} ', self.FLAGS.get(flag, '1;47;30'))} " if flag else ""
                )
                body = f"{badge}{d['message']}"
            case "weather":
                rain = "  " + self.paint("RAIN", "1;34") if d["rainfall"] else ""
                body = (
                    f"air {d['air_c']:.1f}°C  track {d['track_c']:.1f}°C  "
                    f"humidity {d['humidity']:.0f}%{rain}"
                )
            case _:
                body = json.dumps(d, ensure_ascii=False)
        return f"{head}  {self.driver(e['car'])}  {body}"


# ---- Commands ---------------------------------------------------------------------------------


def _ensure_race(race_id: str) -> dict:
    summary = races.summary(race_id)
    if summary is None:
        print(f"{race_id} isn't downloaded yet; fetching it once from OpenF1.", file=sys.stderr)
        with OpenF1() as api:
            path = races.fetch(api, race_id, progress=lambda m: print(m, file=sys.stderr))
        summary = json.loads((path / "race.json").read_text("utf-8"))
    return summary


def cmd_races(args: argparse.Namespace) -> int:
    with OpenF1() as api:
        for r in races.list_races(api, args.year):
            print(f"{r.id:<24} {r.starts_at:%d %b}  {r.circuit} ({r.country})")
    return 0


def cmd_fetch(args: argparse.Namespace) -> int:
    started = time.monotonic()
    with OpenF1() as api:
        path = races.fetch(
            api, args.race, force=args.force, progress=lambda m: print(m, flush=True)
        )
    summary = json.loads((path / "race.json").read_text("utf-8"))
    print(f"Ready: {summary['events']:,} events in {path} ({time.monotonic() - started:.0f} s)")
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    summary = races.summary(args.race)
    if summary is None:
        print(f"{args.race} isn't downloaded. Run: pitwall fetch {args.race}", file=sys.stderr)
        return 1
    s = summary["session"]
    print(f"{s['name']} · {s['circuit']}, {s['country']} · {s['year']}")
    print(f"Scheduled start {s['starts_at']} · {s['laps']} laps · {len(s['drivers'])} drivers")
    duration = summary["last_t"] - summary["first_t"]
    print(f"{summary['events']:,} events over {race_clock(duration).strip()}")
    for kind, count in summary["by_type"].items():
        print(f"  {kind:<15} {count:>9,}")
    first = summary["lap_starts"].get("1")
    if first is not None:
        print(f"Lap 1 starts at {race_clock(first).strip()} after the scheduled start")
    return 0


def _start_t(summary: dict, from_lap: int) -> int | None:
    if from_lap <= 0:
        return None
    try:
        return summary["lap_starts"][str(from_lap)]
    except KeyError:
        last = max(map(int, summary["lap_starts"]), default=0)
        raise SystemExit(f"There's no lap {from_lap}; this race has laps 1 to {last}") from None


def cmd_replay(args: argparse.Namespace) -> int:
    summary = _ensure_race(args.race)
    path = races.race_dir(summary["race_id"]) / "race.jsonl.gz"
    types = tuple(t.strip() for t in args.types.split(",") if t.strip()) if args.types else ()
    if args.format == "pretty" and not types:
        types = tuple(t for t in EVENT_TYPES if t not in QUIET)
    cars = frozenset(int(c) for c in args.cars.split(",")) if args.cars else frozenset()

    out = sys.stdout
    if args.speed > 0 and hasattr(out, "reconfigure"):
        out.reconfigure(line_buffering=True)  # a live stream must not sit in a pipe's buffer
    if args.format == "jsonl":

        def write(event: dict) -> None:
            out.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    else:
        pretty = Pretty(Painter(out.isatty() and not os.environ.get("NO_COLOR")))

        def write(event: dict) -> None:
            out.write(pretty.line(event) + "\n")

    async def emit(event: dict) -> None:
        write(event)

    if args.to == "kafka":
        return _replay_to_kafka(args, summary, path, types, cars)

    stats = Stats()
    started = time.monotonic()
    pace = "as fast as possible" if args.speed == 0 else f"at {args.speed:g}x"
    print(f"Replaying {summary['race_id']} {pace}. Ctrl+C stops.", file=sys.stderr)
    try:
        asyncio.run(
            replay(
                races.read_jsonl(path),
                emit,
                speed=args.speed,
                start_t=_start_t(summary, args.from_lap),
                keep=Filter(types=types, cars=cars),
                limit=args.limit,
                stats=stats,
            )
        )
    except KeyboardInterrupt:
        pass
    except BrokenPipeError:
        sys.stderr.close()  # the reader went away (e.g. | head); nothing more to say
        return 0
    out.flush()
    covered = (stats.last_t - stats.first_t) if stats.first_t is not None else 0
    print(
        f"\nSent {stats.sent:,} events covering {race_clock(covered).strip()} of racing "
        f"in {time.monotonic() - started:.1f} s.",
        file=sys.stderr,
    )
    return 0


def _replay_to_kafka(
    args: argparse.Namespace, summary: dict, path: Path, types: tuple, cars: frozenset
) -> int:
    """Sends the race to Redpanda's pitwall.raw topic, as the in-cluster replayer does."""
    from pitwall import bus

    run = bus.new_run()
    headers = [(bus.RUN_HEADER, run.encode())]

    async def main() -> Stats:
        await bus.ensure_topics()
        producer = bus.producer(linger_ms=20)
        await producer.start()

        async def emit(event: dict) -> None:
            await producer.send(bus.RAW, bus.encode(event), key=bus.key(event), headers=headers)

        try:
            return await replay(
                races.read_jsonl(path),
                emit,
                speed=args.speed,
                start_t=_start_t(summary, args.from_lap),
                keep=Filter(types=types if args.types else (), cars=cars),
                limit=args.limit,
                catch_up=True,  # services joining mid-race need the race so far
            )
        finally:
            await producer.stop()

    print(f"Run {run}: {summary['race_id']} to {bus.brokers()} ({bus.RAW})", file=sys.stderr)
    try:
        stats = asyncio.run(main())
    except KeyboardInterrupt:
        return 0
    print(f"Sent {stats.sent:,} events.", file=sys.stderr)
    return 0


def cmd_service(args: argparse.Namespace) -> int:
    from pitwall.services import run

    run(args.name, args.port)
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    summary = races.summary(args.race)
    if summary is None:
        print(f"{args.race} isn't downloaded. Run: pitwall fetch {args.race}", file=sys.stderr)
        return 1
    path = races.race_dir(summary["race_id"]) / "race.jsonl.gz"
    problems, last_t, count = 0, None, 0
    for expected_seq, event in enumerate(races.read_jsonl(path)):
        count += 1
        try:
            validate(event)
        except ValidationError as error:
            problems += 1
            if problems <= 5:
                print(f"seq {event.get('seq')}: {error.errors()[0]['msg']}", file=sys.stderr)
        if event["seq"] != expected_seq:
            problems += 1
            print(f"seq {event['seq']} where {expected_seq} was expected", file=sys.stderr)
        if last_t is not None and event["t"] < last_t:
            problems += 1
            print(f"seq {event['seq']} goes back in time", file=sys.stderr)
        last_t = event["t"]
    verdict = "all valid" if not problems else f"{problems} problems"
    print(f"{count:,} events checked: {verdict}")
    return 1 if problems else 0


def cmd_schema(args: argparse.Namespace) -> int:
    text = json.dumps(json_schema(), ensure_ascii=False, indent=2) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8", newline="\n")
    else:
        sys.stdout.write(text)
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pitwall",
        description="Download real races from OpenF1 and replay them as a live event stream.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"Races are kept in {races.home() / 'races'} (set PITWALL_HOME to move them).",
    )
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("races", help="List a year's races")
    s.add_argument("year", type=int)
    s.set_defaults(run=cmd_races)

    s = sub.add_parser("fetch", help="Download a race from OpenF1")
    s.add_argument("race", help="e.g. 2024-sao-paulo")
    s.add_argument("--force", action="store_true", help="Download again from scratch")
    s.set_defaults(run=cmd_fetch)

    s = sub.add_parser("info", help="Summarise a downloaded race")
    s.add_argument("race")
    s.set_defaults(run=cmd_info)

    s = sub.add_parser("replay", help="Stream a race as it happened")
    s.add_argument("race")
    s.add_argument("--speed", type=float, default=1.0, help="1 is real time; 0 is flat out")
    s.add_argument(
        "--from-lap", type=int, default=1, help="Start at this lap (0: from the first data)"
    )
    s.add_argument("--types", help="Comma-separated event types or prefixes, e.g. lap,pit,car")
    s.add_argument("--cars", help="Comma-separated car numbers, e.g. 1,44")
    s.add_argument("--format", choices=("pretty", "jsonl"), default="pretty")
    s.add_argument("--limit", type=int, help="Stop after this many events")
    s.add_argument(
        "--to",
        choices=("stdout", "kafka"),
        default="stdout",
        help="Where to send events; kafka uses PITWALL_BROKERS (default localhost:9092)",
    )
    s.set_defaults(run=cmd_replay)

    s = sub.add_parser("service", help="Run one of Pitwall's services")
    s.add_argument("name", choices=("ingest", "timing", "strategy", "api", "replayer"))
    s.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    s.set_defaults(run=cmd_service)

    s = sub.add_parser("validate", help="Check a downloaded race against the event schema")
    s.add_argument("race")
    s.set_defaults(run=cmd_validate)

    s = sub.add_parser("schema", help="Print the event JSON Schema")
    s.add_argument("--out", help="Write it to this file instead")
    s.set_defaults(run=cmd_schema)
    return p


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        encoding = (getattr(stream, "encoding", None) or "").lower().replace("-", "")
        if hasattr(stream, "reconfigure") and encoding != "utf8":
            stream.reconfigure(encoding="utf-8", errors="replace")  # São Paulo on any console
    args = parser().parse_args(argv)
    try:
        return args.run(args)
    except (LookupError, OpenF1Error) as error:
        print(f"pitwall: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
