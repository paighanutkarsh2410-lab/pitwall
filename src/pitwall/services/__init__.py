"""Pitwall's services. Each one is a small FastAPI app whose real work is a background worker.

    pitwall service ingest     validate raw events, route them, record history
    pitwall service timing     keep the live timing board
    pitwall service strategy   tyre stints, degradation and pit loss
    pitwall service api        the pit wall's WebSocket and REST API, and the screen itself
    pitwall service replayer   replay races into Redpanda on request

Every service answers:

    /healthz   the process is alive (Kubernetes liveness)
    /readyz    its worker is connected and working (readiness)
    /metrics   Prometheus metrics (pitwall.observe)
    /faults    with PITWALL_FAULTS=true only: inject a delay for a drill, e.g.
               curl -X POST .../faults -d '{"delay_ms": 800}'
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from pitwall import observe, tracing

SERVICES = ("ingest", "timing", "strategy", "api", "replayer")
INTERNAL = ("/metrics", "/faults")  # never served to requests that came through the ingress

log = logging.getLogger("pitwall")


class JsonLogs(logging.Formatter):
    """One JSON object per line, with the trace id when there is one, so Loki can link a log
    line to its trace in Tempo."""

    def format(self, record: logging.LogRecord) -> str:
        from opentelemetry import trace

        line = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
            "service": os.environ.get("PITWALL_SERVICE", ""),
        }
        span = trace.get_current_span().get_span_context()
        if span.is_valid:
            line["trace_id"] = format(span.trace_id, "032x")
        if record.exc_info:
            line["error"] = self.formatException(record.exc_info)
        return json.dumps(line, ensure_ascii=False)


def configure_logging() -> None:
    root = logging.getLogger()
    if getattr(root, "_pitwall", False):
        return
    handler = logging.StreamHandler()
    if os.environ.get("PITWALL_LOG_FORMAT") == "json":
        handler.setFormatter(JsonLogs())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root.handlers = [handler]
    root.setLevel(os.environ.get("PITWALL_LOG_LEVEL", "INFO"))
    root._pitwall = True  # type: ignore[attr-defined]
    logging.getLogger("aiokafka").setLevel(logging.WARNING)


@dataclass
class Health:
    ready: bool = False
    detail: str = "starting"
    counters: dict[str, int] = field(default_factory=dict)

    def count(self, name: str, n: int = 1) -> None:
        self.counters[name] = self.counters.get(name, 0) + n


class Faults:
    """Deliberate trouble for drills: a delay the worker waits before each batch it handles."""

    def __init__(self, service: str) -> None:
        self.service = service
        self.delay_ms = 0

    def set(self, delay_ms: int) -> None:
        self.delay_ms = delay_ms
        observe.FAULT_DELAY.labels(self.service).set(delay_ms / 1000)
        log.warning("Fault injection: %s now waits %d ms per batch", self.service, delay_ms)

    async def pause(self) -> None:
        if self.delay_ms:
            await asyncio.sleep(self.delay_ms / 1000)


class FaultRequest(BaseModel):
    delay_ms: int = Field(ge=0, le=60_000)


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
    from prometheus_client import make_asgi_app

    health = Health()

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        os.environ.setdefault("PITWALL_SERVICE", name)
        configure_logging()
        tracing.setup(name)
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
    app.state.faults = faults_of(name)
    app.mount("/metrics", make_asgi_app())

    @app.middleware("http")
    async def measure(request: Request, call_next):
        # Metrics and the drill switch are for inside the cluster (Prometheus scrapes pods
        # directly). Anything that came through the ingress carries X-Forwarded-For.
        if request.url.path.startswith(INTERNAL) and "x-forwarded-for" in request.headers:
            return JSONResponse({"detail": "Not available through the ingress"}, status_code=404)
        started = time.perf_counter()
        response = await call_next(request)
        route = request.scope.get("route")
        path = getattr(route, "path", "other")
        if path not in ("/metrics", "/healthz", "/readyz"):
            observe.HTTP_REQUESTS.labels(name, path, str(response.status_code)).inc()
            observe.HTTP_SECONDS.labels(name, path).observe(time.perf_counter() - started)
        return response

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict:
        return {"service": name, "alive": True}

    @app.get("/readyz", include_in_schema=False)
    async def readyz(response: Response) -> dict:
        if not health.ready:
            response.status_code = 503
        return {"service": name, "ready": health.ready, "detail": health.detail, **health.counters}

    @app.get("/faults", include_in_schema=False)
    async def get_faults() -> dict:
        return {"service": name, "delay_ms": app.state.faults.delay_ms}

    @app.post("/faults", include_in_schema=False)
    async def set_faults(request: FaultRequest) -> dict:
        if os.environ.get("PITWALL_FAULTS", "").lower() not in {"1", "true", "yes"}:
            raise HTTPException(403, "Fault injection is off (PITWALL_FAULTS)")
        app.state.faults.set(request.delay_ms)
        return {"service": name, "delay_ms": request.delay_ms}

    return app


_faults: dict[str, Faults] = {}


def faults_of(name: str) -> Faults:
    """The fault switch for a service; workers call ``await faults_of(name).pause()``."""
    return _faults.setdefault(name, Faults(name))


def run(name: str, port: int) -> None:
    import uvicorn

    if name not in SERVICES:
        raise SystemExit(f"Unknown service {name}; one of {', '.join(SERVICES)}")
    os.environ.setdefault("PITWALL_SERVICE", name)
    configure_logging()
    uvicorn.run(
        f"pitwall.services.{name}:app",
        host=os.environ.get("PITWALL_HOST", "0.0.0.0"),
        port=port,
        log_level="warning",
        proxy_headers=True,
    )
