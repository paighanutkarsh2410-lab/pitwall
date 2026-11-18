"""Pitwall's services. Each one is a small FastAPI app whose real work is a background worker.

    pitwall service ingest     validate raw events, route them, record history
    pitwall service timing     keep the live timing board
    pitwall service strategy   tyre stints, degradation and pit loss
    pitwall service api        the pit wall's WebSocket and REST API, and the screen itself
    pitwall service replayer   replay races into Redpanda on request

Every service answers /healthz (the process is alive) and /readyz (its worker is connected and
working), which Kubernetes probes.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field

from fastapi import FastAPI, Response

SERVICES = ("ingest", "timing", "strategy", "api", "replayer")

log = logging.getLogger("pitwall")


def configure_logging() -> None:
    logging.basicConfig(
        level=os.environ.get("PITWALL_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logging.getLogger("aiokafka").setLevel(logging.WARNING)


@dataclass
class Health:
    ready: bool = False
    detail: str = "starting"
    counters: dict[str, int] = field(default_factory=dict)

    def count(self, name: str, n: int = 1) -> None:
        self.counters[name] = self.counters.get(name, 0) + n


Worker = Callable[[Health], Awaitable[None]]


async def supervise(name: str, worker: Worker, health: Health) -> None:
    """Runs the worker forever; if it fails (Redpanda not up yet, a lost connection), it is
    restarted with backoff and the service reports not-ready meanwhile."""
    delay = 1.0
    while True:
        try:
            await worker(health)
            return
        except asyncio.CancelledError:
            raise
        except Exception as error:
            health.ready = False
            health.detail = f"{type(error).__name__}: {error}"
            log.warning("%s worker failed (%s); retrying in %.0f s", name, health.detail, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)


def service_app(name: str, worker: Worker, app: FastAPI | None = None) -> FastAPI:
    health = Health()

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        configure_logging()
        task = asyncio.create_task(supervise(name, worker, health), name=f"{name}-worker")
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app = app or FastAPI(title=f"pitwall-{name}")
    app.router.lifespan_context = lifespan
    app.state.health = health

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict:
        return {"service": name, "alive": True}

    @app.get("/readyz", include_in_schema=False)
    async def readyz(response: Response) -> dict:
        if not health.ready:
            response.status_code = 503
        return {"service": name, "ready": health.ready, "detail": health.detail, **health.counters}

    return app


def run(name: str, port: int) -> None:
    import uvicorn

    if name not in SERVICES:
        raise SystemExit(f"Unknown service {name}; one of {', '.join(SERVICES)}")
    configure_logging()
    uvicorn.run(
        f"pitwall.services.{name}:app",
        host=os.environ.get("PITWALL_HOST", "0.0.0.0"),
        port=port,
        log_level="warning",
        proxy_headers=True,
    )
