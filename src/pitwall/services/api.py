"""pitwall-api: the pit wall's WebSocket and REST API, and the screen itself.

WS   /ws                 five frames a second: board, strategy, car positions, the watched
                         car's telemetry and, once traced, the circuit outline. Send
                         {"watch": 1} to choose the car whose telemetry you receive.
GET  /api/state          the same, once
GET  /api/laps/{car}     every lap of a car in the current run (TimescaleDB)
GET  /api/races          races the replayer has on disk
GET  /api/replay         what's playing        POST/PATCH/DELETE: start, change speed, stop
GET  /api/logos          team logos available on this machine (see assets/README.md)
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response

from pitwall import bus, history, observe, tracing
from pitwall.live import Live
from pitwall.services import Health, faults_of, service_app

log = logging.getLogger("pitwall.api")

FRAME_EVERY = 0.2
REPLAYER = os.environ.get("PITWALL_REPLAYER_URL", "http://replayer:8080").rstrip("/")
LOGOS = Path(os.environ.get("PITWALL_LOGOS_DIR", "/logos"))
WEB = os.environ.get("PITWALL_WEB_DIST")
LOGO_FILE = re.compile(r"^[a-z0-9-]+\.(png|svg|webp)$")

live = Live()
db: dict = {}


async def follow(health: Health) -> None:
    """Board and strategy are compacted topics: read from the start to get the latest of each.
    Car data is high-rate: only what arrives from now on matters."""
    await bus.ensure_topics()
    snapshots = bus.consumer(bus.BOARD, bus.STRATEGY, group=None, auto_offset_reset="earliest")
    cars = bus.consumer(bus.TELEMETRY, group=None, auto_offset_reset="latest")
    await snapshots.start()
    await cars.start()
    if history.dsn():
        with contextlib.suppress(Exception):
            db["pool"] = await history.wait_for_db(attempts=3)
    health.ready, health.detail = True, "following the board, strategy and telemetry"

    async def pump_snapshots() -> None:
        async for message in snapshots:
            value = bus.decode(message.value)
            (live.on_board if message.topic == bus.BOARD else live.on_strategy)(value)
            health.count("snapshots")

    async def pump_cars() -> None:
        faults = faults_of("api")
        last_lag = 0.0
        while True:
            batches = await cars.getmany(timeout_ms=200, max_records=5000)
            if batches:
                await faults.pause()
            for messages in batches.values():
                for message in messages:
                    event = bus.decode(message.value)
                    with tracing.span_from(message.headers, "api.receive", event):
                        accepted = live.on_car(event, bus.run_of(message.headers))
                    if accepted:
                        observe.observe_freshness("api", message.headers)
                        observe.EVENTS.labels("api", event["type"], "received").inc()
                    health.count("car_events")
            if time.monotonic() - last_lag > 2:
                for topic, lag in (await bus.lag_by_topic(cars)).items():
                    observe.CONSUMER_LAG.labels("api", topic).set(lag)
                last_lag = time.monotonic()

    try:
        await asyncio.gather(pump_snapshots(), pump_cars())
    finally:
        await snapshots.stop()
        await cars.stop()


api = FastAPI(title="pitwall-api")


def state() -> dict:
    return {
        "board": live.board,
        "strategy": live.strategy,
        "positions": live.positions_frame(),
        "track": live.track(),
    }


@api.get("/api/state")
async def get_state() -> dict:
    return state()


@api.websocket("/ws")
async def stream(socket: WebSocket) -> None:
    await socket.accept()
    observe.WEBSOCKETS.inc()
    # Up to two cars' telemetry (a team's pair), each with the last sample sent.
    watch: dict[int, int | None] = {}
    sent = {"board": -1, "strategy": -1, "positions": -1, "track": None}

    async def receive() -> None:
        while True:
            message = json.loads(await socket.receive_text())
            if "watch" in message:
                wanted = message["watch"]
                cars = wanted if isinstance(wanted, list) else [wanted]
                watch.clear()
                watch.update({int(car): None for car in cars[:2] if car is not None})

    async def send() -> None:
        while True:
            frame: dict = {}
            if live.board_version != sent["board"]:
                frame["board"], sent["board"] = live.board, live.board_version
            if live.strategy_version != sent["strategy"]:
                frame["strategy"], sent["strategy"] = live.strategy, live.strategy_version
            if live.positions_version != sent["positions"]:
                frame["positions"] = live.positions_frame()
                sent["positions"] = live.positions_version
            track = live.track()
            if track and sent["track"] != track["race"]:
                frame["track"], sent["track"] = track, track["race"]
            telemetry = {}
            for car, after in list(watch.items()):
                samples = live.telemetry_since(car, after)
                if samples:
                    telemetry[str(car)] = samples
                    watch[car] = samples[-1][0]
            if telemetry:
                frame["telemetry"] = telemetry
            if frame:
                await socket.send_text(json.dumps(frame, separators=(",", ":")))
                observe.FRAMES.inc()
            await asyncio.sleep(FRAME_EVERY)

    tasks = [asyncio.create_task(receive()), asyncio.create_task(send())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        observe.WEBSOCKETS.dec()
        for task in tasks:
            task.cancel()


@api.get("/api/laps/{car}")
async def laps(car: int) -> list[dict]:
    pool = db.get("pool")
    if pool is None or live.run is None:
        return []
    return await history.laps_of(pool, live.run, car)


@api.get("/api/trace")
async def trace() -> dict:
    pool = db.get("pool")
    if pool is None or live.run is None:
        return {"laps": 0, "cars": {}}
    return await history.race_trace(pool, live.run)


async def replayer(method: str, path: str, body: bytes | None = None) -> Response:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            upstream = await client.request(
                method, f"{REPLAYER}{path}", content=body,
                headers={"Content-Type": "application/json"},
            )  # fmt: skip
    except httpx.HTTPError as error:
        raise HTTPException(502, f"The replayer is unreachable: {error}") from error
    return JSONResponse(upstream.json(), status_code=upstream.status_code)


@api.get("/api/races")
async def races() -> Response:
    return await replayer("GET", "/races")


@api.get("/api/catalog/{year}")
async def catalog(year: int) -> Response:
    return await replayer("GET", f"/catalog/{year}")


@api.post("/api/downloads")
async def download(request: Request) -> Response:
    return await replayer("POST", "/downloads", await request.body())


@api.api_route("/api/replay", methods=["GET", "POST", "PATCH", "DELETE"])
async def replay(request: Request) -> Response:
    if request.method == "POST":
        return await replayer("POST", "/replays", await request.body())
    return await replayer(request.method, "/replays/current", await request.body() or None)


@api.get("/api/logos")
async def logos() -> dict:
    """Logos you keep on your own machine (never in Git); without them the screen shows badges."""
    if not LOGOS.is_dir():
        return {}
    return {
        f.stem: f"/api/logos/{f.name}" for f in sorted(LOGOS.iterdir()) if LOGO_FILE.match(f.name)
    }


@api.get("/api/logos/{name}")
async def logo(name: str) -> FileResponse:
    if not LOGO_FILE.match(name) or not (LOGOS / name).is_file():
        raise HTTPException(404)
    return FileResponse(LOGOS / name)


def serve_screen(dist: Path) -> None:
    """The built pit-wall screen, with index.html for any path the screen routes itself."""
    root = dist.resolve()

    @api.get("/{path:path}", include_in_schema=False)
    async def screen(path: str) -> FileResponse:
        if path.startswith(("api/", "ws")):
            raise HTTPException(404)
        target = (root / path).resolve()
        if path and target.is_file() and target.is_relative_to(root):
            return FileResponse(target)
        return FileResponse(root / "index.html")


app = service_app("api", follow, api)

# Last, so /healthz, /readyz and the API win over the screen's catch-all route.
if WEB and Path(WEB, "index.html").is_file():
    serve_screen(Path(WEB))
