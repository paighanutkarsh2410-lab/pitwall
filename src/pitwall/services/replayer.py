"""replayer: replays races into pitwall.raw on request.

    GET    /races              races on disk
    GET    /replays/current    what's playing: race, speed, race time, events sent
    POST   /replays            {"race": "2024-sao-paulo", "speed": 10, "from_lap": 1}
    PATCH  /replays/current    {"speed": 20}: change speed without restarting
    DELETE /replays/current    stop

A race that isn't on disk yet is downloaded from OpenF1 first (a few minutes). Each replay is a
new run with its own id in the pitwall-run header, so every service starts the board afresh.
PITWALL_AUTOSTART=2024-sao-paulo starts a replay when the service starts (PITWALL_LOOP=true
starts it again when it finishes).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from pitwall import bus
from pitwall import race as races
from pitwall.openf1 import OpenF1
from pitwall.replay import Pace, Stats, replay
from pitwall.services import Health, service_app

log = logging.getLogger("pitwall.replayer")


class Start(BaseModel):
    race: str = Field(pattern=r"^\d{4}-[a-z0-9-]+$")
    speed: float = Field(1.0, ge=0, le=200)
    from_lap: int = Field(1, ge=0)


class Change(BaseModel):
    speed: float = Field(ge=0, le=200)


class Download(BaseModel):
    race: str = Field(pattern=r"^\d{4}-[a-z0-9-]+$")


class Downloads:
    """Downloads races one at a time (OpenF1's free tier allows 30 requests a minute)."""

    def __init__(self) -> None:
        self.status: dict[str, dict] = {}
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.catalog: dict[int, tuple[float, list]] = {}

    def request(self, race_id: str) -> dict:
        current = self.status.get(race_id, {}).get("state")
        if races.summary(race_id) is None and current not in {"queued", "downloading"}:
            self.status[race_id] = {"race": race_id, "state": "queued", "detail": ""}
            self.queue.put_nowait(race_id)
        return self.view(race_id)

    def view(self, race_id: str) -> dict:
        if races.summary(race_id) is not None:
            return {"race": race_id, "state": "ready", "detail": ""}
        return self.status.get(race_id, {"race": race_id, "state": "missing", "detail": ""})

    async def work(self) -> None:
        while True:
            race_id = await self.queue.get()
            status = self.status[race_id]
            status["state"] = "downloading"

            def progress(message: str, status: dict = status) -> None:
                status["detail"] = message.strip()

            try:
                await asyncio.to_thread(_fetch_with, race_id, progress)
                status["state"], status["detail"] = "ready", ""
            except Exception as error:
                status["state"], status["detail"] = "failed", f"{type(error).__name__}: {error}"
                log.warning("Download of %s failed: %s", race_id, error)

    async def season(self, year: int) -> list[dict]:
        """A year's races from OpenF1 (cached for ten minutes), marked as downloaded or not."""
        cached = self.catalog.get(year)
        if cached is None or time.monotonic() - cached[0] > 600:
            refs = await asyncio.to_thread(_season, year)
            self.catalog[year] = (time.monotonic(), refs)
        now = datetime.now(UTC)
        out = []
        for ref in self.catalog[year][1]:
            view = self.view(ref.id)
            free = ref.free_from()
            out.append(
                {
                    "race": ref.id,
                    "location": ref.location,
                    "country": ref.country,
                    "circuit": ref.circuit,
                    "starts_at": ref.starts_at.isoformat(),
                    "state": view["state"] if now >= free else "upcoming",
                    "free_from": free.isoformat(),
                    "detail": view["detail"],
                }
            )
        return out


def _season(year: int) -> list:
    with OpenF1() as api:
        return races.list_races(api, year)


def _fetch_with(race_id: str, progress) -> None:
    with OpenF1() as api:
        races.fetch(api, race_id, progress=progress)


downloads = Downloads()


@dataclass
class Run:
    id: str
    race: str
    pace: Pace
    from_lap: int
    state: str = "starting"  # downloading, playing, finished, stopped, failed
    detail: str = ""
    started: float = field(default_factory=time.time)
    stats: Stats = field(default_factory=Stats)
    task: asyncio.Task | None = None

    def view(self) -> dict:
        return {
            "run": self.id,
            "race": self.race,
            "speed": self.pace.speed,
            "from_lap": self.from_lap,
            "state": self.state,
            "detail": self.detail,
            "sent": self.stats.sent,
            "race_t": self.stats.last_t,
            "behind_s": round(self.stats.behind_s, 3),
        }


class Replayer:
    def __init__(self) -> None:
        self.current: Run | None = None
        self.producer = None
        self.next: asyncio.Task | None = None
        self.loop = os.environ.get("PITWALL_LOOP", "").lower() in {"1", "true", "yes"}

    async def start(self, request: Start) -> Run:
        await self.stop()
        run = Run(bus.new_run(), request.race, Pace(request.speed), request.from_lap)
        run.task = asyncio.create_task(self._play(run), name=f"replay-{run.id}")
        self.current = run
        return run

    async def stop(self) -> None:
        run = self.current
        if run and run.task and not run.task.done():
            run.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await run.task
            run.state = "stopped"

    async def _play(self, run: Run) -> None:
        try:
            summary = races.summary(run.race)
            if summary is None:
                run.state, run.detail = "downloading", "fetching the race from OpenF1"
                downloads.request(run.race)
                while downloads.view(run.race)["state"] in {"queued", "downloading"}:
                    run.detail = downloads.view(run.race)["detail"] or run.detail
                    await asyncio.sleep(1)
                summary = races.summary(run.race)
                if summary is None:
                    raise RuntimeError(downloads.view(run.race)["detail"] or "download failed")
            start_t = None
            if run.from_lap > 0:
                start_t = summary["lap_starts"].get(str(run.from_lap))
                if start_t is None:
                    raise ValueError(f"{run.race} has no lap {run.from_lap}")
            run.state, run.detail = "playing", ""
            log.info(
                "Run %s: %s at %gx from lap %s", run.id, run.race, run.pace.speed, run.from_lap
            )
            headers = [(bus.RUN_HEADER, run.id.encode())]

            async def emit(event: dict) -> None:
                await self.producer.send(
                    bus.RAW, bus.encode(event), key=bus.key(event), headers=headers
                )

            path = races.race_dir(summary["race_id"]) / "race.jsonl.gz"
            await replay(
                races.read_jsonl(path),
                emit,
                speed=run.pace,
                start_t=start_t,
                stats=run.stats,
                catch_up=True,
            )
            await self.producer.flush()
            run.state = "finished"
            log.info("Run %s finished: %s events", run.id, run.stats.sent)
            if self.loop:
                await asyncio.sleep(5)
                again = Start(race=run.race, speed=run.pace.speed, from_lap=run.from_lap)
                # Scheduled, not awaited: start() stops the current run, which is this task.
                self.next = asyncio.create_task(self.start(again))
        except asyncio.CancelledError:
            raise
        except Exception as error:
            run.state, run.detail = "failed", f"{type(error).__name__}: {error}"
            log.exception("Run %s failed", run.id)


replayer = Replayer()


async def work(health: Health) -> None:
    await bus.ensure_topics()
    replayer.producer = bus.producer(linger_ms=20)
    await replayer.producer.start()
    downloader = asyncio.create_task(downloads.work(), name="downloads")
    health.ready, health.detail = True, "connected to Redpanda"
    autostart = os.environ.get("PITWALL_AUTOSTART")
    if autostart and replayer.current is None:
        speed = float(os.environ.get("PITWALL_AUTOSTART_SPEED", "1"))
        await replayer.start(Start(race=autostart, speed=speed))
    try:
        await asyncio.Event().wait()  # serve requests until shut down
    finally:
        downloader.cancel()
        await replayer.stop()
        await replayer.producer.stop()


api = FastAPI(title="pitwall-replayer")


def _ready() -> None:
    if replayer.producer is None:
        raise HTTPException(503, "Not connected to Redpanda yet")


@api.get("/races")
async def list_races() -> list[dict]:
    root = races.home() / "races"
    found = []
    for summary_file in sorted(root.glob("*/race.json")) if root.exists() else []:
        s = json.loads(summary_file.read_text("utf-8"))
        session = s["session"]
        found.append(
            {
                "race": s["race_id"],
                "name": session["name"],
                "circuit": session["circuit"],
                "year": session["year"],
                "laps": session["laps"],
                "events": s["events"],
            }
        )
    return found


@api.get("/catalog/{year}")
async def catalog(year: int) -> list[dict]:
    if not 2023 <= year <= datetime.now(UTC).year:
        raise HTTPException(404, "OpenF1 has races from 2023 onwards")
    return await downloads.season(year)


@api.post("/downloads", status_code=202)
async def download(request: Download) -> dict:
    return downloads.request(request.race)


@api.get("/downloads/{race}")
async def download_status(race: str) -> dict:
    return downloads.view(race)


@api.get("/replays/current")
async def current() -> dict:
    return replayer.current.view() if replayer.current else {"state": "idle"}


@api.post("/replays", status_code=201)
async def start(request: Start) -> dict:
    _ready()
    return (await replayer.start(request)).view()


@api.patch("/replays/current")
async def change(request: Change) -> dict:
    run = replayer.current
    if run is None or run.state not in {"playing", "downloading", "starting"}:
        raise HTTPException(409, "Nothing is playing")
    run.pace.speed = request.speed
    return run.view()


@api.delete("/replays/current")
async def stop() -> dict:
    await replayer.stop()
    return await current()


app = service_app("replayer", work, api)
