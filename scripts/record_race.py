"""Records a downloaded race as the pit wall sees it, for the static site.

    python scripts/record_race.py 2024-sao-paulo site/public/data

Runs the race's events through the same models the services run (pitwall.timing.Board for the
timing service, pitwall.strategy.Strategy for strategy, pitwall.live.Live for the API's
positions, telemetry and circuit outline) and writes what the pit-wall screen would have been
sent, in one-minute chunks of race time:

    <out>/<race>/manifest.json      the session, the circuit, the chunks, when each lap started
    <out>/<race>/chunk-0042.json.gz boards, strategy, positions (2 a second) and telemetry, gzipped
    <out>/<race>/story.json         the race in laps, for the broadcast page: order per lap,
                                    the grid, gaps, pit stops, weather, race control

Nothing is simulated: every number comes from the race's own events through Pitwall's code.
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from pitwall import race as races  # noqa: E402
from pitwall.live import Live  # noqa: E402
from pitwall.strategy import Strategy  # noqa: E402
from pitwall.timing import Board  # noqa: E402

RUN = "recording"
CHUNK_MS = 60_000  # race time per file
BOARD_EVERY = 1_000  # the timing service publishes about once a second
STRATEGY_EVERY = 5_000
POSITIONS_EVERY = 500  # twice a second; the screen eases the dots between them
TELEMETRY_EVERY = 450  # about two samples a second per car, from the ~3.7 the cars send
LEAD_IN_MS = 90_000  # start a little before lights out: the grid, the formation finish


def compact(value):
    """Rounds floats so the files stay small without changing what the screen shows."""
    if isinstance(value, float):
        return round(value, 3)
    if isinstance(value, dict):
        return {k: compact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [compact(v) for v in value]
    return value


def write(path: Path, data, packed: bool = False) -> int:
    """Writes JSON; packed files are gzipped (the browser unpacks them), since a static host
    counts what is stored, and a race's chunks shrink about 15 times."""
    raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode()
    if packed:
        raw = gzip.compress(raw, compresslevel=9, mtime=0)
    path.write_bytes(raw)
    return len(raw)


def lights_out(path: Path) -> int:
    """Race time of lights out: the first lap.started of lap 1."""
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            e = json.loads(line)
            if e["type"] == "lap.started" and e["data"].get("lap") == 1:
                return e["t"]
    return 0


def record(race: str, out: Path) -> None:
    source = races.home() / "races" / race / "race.jsonl.gz"
    if not source.exists():
        raise SystemExit(f"No {source}: run pitwall fetch {race} first")
    start = lights_out(source)
    begin = start - LEAD_IN_MS
    folder = out / race
    folder.mkdir(parents=True, exist_ok=True)

    board, strategy, live = Board(), Strategy(), Live()
    live.race = race  # the API learns it from the first board; the outline is filed under it
    board.reset(RUN)
    strategy.reset(RUN)
    session: dict | None = None
    chunk: dict | None = None
    chunks: list[dict] = []
    lap_starts: dict[int, int] = {}
    next_board = next_strategy = next_positions = begin
    sent_telemetry: dict[int, int] = {}
    board_dirty = strategy_dirty = False
    story_laps: list[dict] = []
    story_events: list[dict] = []
    weather: list[dict] = []
    last_lap_logged = 0
    total_bytes = 0

    def snapshot_board() -> dict:
        snap = board.snapshot()
        snap.pop("session", None)  # sent once, in the manifest
        return compact(snap)

    def flush_chunk() -> None:
        nonlocal chunk, total_bytes
        if chunk is None:
            return
        name = f"chunk-{len(chunks):04d}.json.gz"
        size = write(folder / name, chunk, packed=True)
        total_bytes += size
        chunks.append({"file": name, "t0": chunk["t0"], "t1": chunk["t0"] + CHUNK_MS})
        chunk = None

    def chunk_for(t: int) -> dict:
        nonlocal chunk
        index = (t - begin) // CHUNK_MS
        t0 = begin + index * CHUNK_MS
        if chunk is not None and chunk["t0"] != t0:
            flush_chunk()
        if chunk is None:
            chunk = {"t0": t0, "boards": [], "strategy": [], "positions": [], "telemetry": {}}
        return chunk

    def tick(now: int) -> None:
        """Emits whatever is due at race time ``now``, as the services would have."""
        nonlocal next_board, next_strategy, next_positions, board_dirty, strategy_dirty
        while next_positions <= now:
            c = chunk_for(next_positions)
            frame = live.positions_frame()
            if frame:
                c["positions"].append([next_positions, frame])
            next_positions += POSITIONS_EVERY
        if now >= next_board:
            if board_dirty:
                chunk_for(now)["boards"].append([now, snapshot_board()])
                board_dirty = False
            next_board = now + BOARD_EVERY
        if now >= next_strategy:
            if strategy_dirty:
                chunk_for(now)["strategy"].append([now, compact(strategy.snapshot())])
                strategy_dirty = False
            next_strategy = now + STRATEGY_EVERY

    with gzip.open(source, "rt", encoding="utf-8") as f:
        for line in f:
            e = json.loads(line)
            t, kind = e["t"], e["type"]
            if kind == "session.info":
                session = e["data"]
            if t < begin and kind in ("car.position", "car.telemetry"):
                continue  # the garage and the formation lap: not on the recording
            if kind in ("car.position", "car.telemetry"):
                live.on_car(e, RUN)
            else:
                changed = board.apply(e, RUN)
                board_dirty = board_dirty or changed
                strategy_dirty = strategy.apply(e, RUN) or strategy_dirty
                if kind == "lap.started":
                    lap = e["data"]["lap"]
                    lap_starts.setdefault(lap, t)
                if kind == "weather":
                    d = e["data"]
                    weather.append(
                        {
                            "t": t,
                            "rain": bool(d.get("rainfall")),
                            "track_c": d.get("track_c"),
                            "air_c": d.get("air_c"),
                        }
                    )
                if kind == "race.control" and t >= begin:
                    d = e["data"]
                    story_events.append(
                        {
                            "t": t,
                            "lap": board.lap,
                            "category": d.get("category"),
                            "flag": d.get("flag"),
                            "message": d.get("message"),
                        }
                    )
                if kind == "pit.stop" and t >= begin:
                    d = e["data"]
                    story_events.append(
                        {
                            "t": t,
                            "lap": d.get("lap"),
                            "category": "Pit",
                            "car": e["car"],
                            "stop_ms": d.get("stop_ms"),
                            "pit_lane_ms": d.get("pit_lane_ms"),
                        }
                    )
            if t < begin:
                continue
            if kind == "car.telemetry":
                car = e["car"]
                last = sent_telemetry.get(car)
                for s in live.telemetry_since(car, last):
                    if last is not None and s[0] - last < TELEMETRY_EVERY:
                        continue
                    chunk_for(t)["telemetry"].setdefault(str(car), []).append(list(s))
                    sent_telemetry[car] = last = s[0]
            tick(t)
            # One line of the story per lap of the leader, taken when the leader starts it.
            if board.lap and board.lap != last_lap_logged and kind == "lap.started":
                last_lap_logged = board.lap
                snap = board.snapshot()
                story_laps.append(
                    {
                        "lap": board.lap,
                        "t": t,
                        "track": snap["track"],
                        "order": [c["car"] for c in snap["cars"] if c["position"]],
                        "gaps": {
                            str(c["car"]): c["gap_to_leader"]
                            for c in snap["cars"]
                            if c["gap_to_leader"] is not None
                        },
                        "compounds": {str(c["car"]): c["compound"] for c in snap["cars"]},
                        # Where every car was on the circuit as the leader started the lap.
                        "xy": live.positions_frame(),
                    }
                )
    flush_chunk()

    final = board.snapshot()
    track = live.track()
    manifest = {
        "race": race,
        "session": session,
        "start_t": start,
        "begin_t": begin,
        "end_t": chunks[-1]["t1"] if chunks else begin,
        "chunk_ms": CHUNK_MS,
        "chunks": chunks,
        "laps": {str(k): v for k, v in sorted(lap_starts.items())},
        "track": track,
        "source": "OpenF1 timing data, replayed through Pitwall's timing, strategy and API code",
    }
    total_bytes += write(folder / "manifest.json", manifest)
    story = {
        "race": race,
        "session": session,
        "start_t": start,
        "track": track,
        "grid": {str(c["car"]): c["start_position"] for c in final["cars"]},
        "laps": story_laps,
        "events": story_events,
        "weather": weather,
        "result": [
            {
                "car": c["car"],
                "position": c["position"],
                "gap": c["gap_to_leader"],
                "best_lap_ms": c["best_lap_ms"],
                "pits": c["pits"],
            }
            for c in final["cars"]
        ],
        "fastest_lap": final["fastest_lap"],
    }
    total_bytes += write(folder / "story.json", compact(story))
    print(
        f"{race}: {len(chunks)} chunks, {len(story_laps)} laps, "
        f"{total_bytes / 1e6:.1f} MB written to {folder}"
    )


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    record(sys.argv[1], Path(sys.argv[2]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
