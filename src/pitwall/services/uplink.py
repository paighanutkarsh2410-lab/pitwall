"""uplink: carries the trackside stream to the factory, over a link that can fail.

    trackside Redpanda --pitwall.raw--> uplink --(Toxiproxy: the link)--> factory Redpanda

A team's trackside data centre streams to its factory over a long-haul link that can slow down
or drop. The uplink forwards every message unchanged (key, value and headers, so the replayer's
send time still measures end-to-end freshness) and commits its position on the trackside only
once the factory has confirmed the batch. When the link breaks it keeps everything: the
trackside Redpanda is the buffer, the uplink rewinds to the last confirmed position and sends it
all again when the link returns. Re-sent events can arrive twice; ingest drops the duplicates
(pitwall.delivery).

It measures the outages and how long catching up takes, and, for drills (PITWALL_FAULTS), can
cut, slow or narrow the link through Toxiproxy:

    POST /link {"enabled": false}                        cut it
    POST /link {"enabled": true, "latency_ms": 300}      slow it
    POST /link {"enabled": true, "bandwidth_kbps": 200}  narrow it
    POST /link {"enabled": true}                         restore it
    GET  /link                                           how it is now, and the last recovery
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from pitwall import bus, observe
from pitwall.delivery import LinkTracker
from pitwall.services import Health, service_app

log = logging.getLogger("pitwall.uplink")

TARGET = os.environ.get("PITWALL_UPLINK_BROKERS", "toxiproxy:19093")
TOXIPROXY = os.environ.get("PITWALL_TOXIPROXY_URL", "http://toxiproxy:8474").rstrip("/")
PROXY = os.environ.get("PITWALL_TOXIPROXY_PROXY", "factory-kafka")
SEND_TIMEOUT = 15.0

tracker = LinkTracker()


def target_producer():
    from aiokafka import AIOKafkaProducer

    return AIOKafkaProducer(
        bootstrap_servers=TARGET,
        acks="all",
        enable_idempotence=True,
        linger_ms=20,
        request_timeout_ms=8000,
        retry_backoff_ms=500,
    )


async def backlog(consumer) -> int:
    """Messages on the trackside the factory hasn't confirmed: the buffer during an outage."""
    total = 0
    for tp in consumer.assignment():
        end = consumer.highwater(tp)
        if end is None:
            continue
        committed = await consumer.committed(tp)
        total += max(0, end - (committed or 0))
    return total


async def rewind(consumer, partitions) -> None:
    """Back to the last position the factory confirmed, so nothing unconfirmed is skipped."""
    for tp in partitions:
        committed = await consumer.committed(tp)
        if committed is None:
            await consumer.seek_to_beginning(tp)
        else:
            consumer.seek(tp, committed)


async def work(health: Health) -> None:
    await bus.ensure_topics(only=(bus.RAW,))
    consumer = bus.consumer(
        bus.RAW, group="uplink", auto_offset_reset="earliest", enable_auto_commit=False
    )
    await consumer.start()
    producer = None
    health.ready, health.detail = True, f"forwarding {bus.RAW} to {TARGET}"
    log.info("uplink: %s -> %s", bus.brokers(), TARGET)
    backoff, last_backlog = 1.0, 0.0
    try:
        while True:
            if producer is None:
                producer = target_producer()
                try:
                    await asyncio.wait_for(producer.start(), timeout=SEND_TIMEOUT)
                except (TimeoutError, Exception) as error:
                    await _drop(producer)
                    producer = None
                    _down(health, f"can't reach the factory: {type(error).__name__}")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 5)
                    continue

            batches = await consumer.getmany(timeout_ms=200, max_records=2000)
            if batches:
                try:
                    sent = await asyncio.wait_for(_forward(producer, batches), SEND_TIMEOUT)
                    await consumer.commit({tp: msgs[-1].offset + 1 for tp, msgs in batches.items()})
                except (TimeoutError, Exception) as error:
                    await rewind(consumer, batches.keys())
                    await _drop(producer)
                    producer = None
                    _down(health, f"lost the factory: {type(error).__name__}")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 5)
                    continue
                backoff = 1.0
                newest = max((m for msgs in batches.values() for m in msgs), key=lambda m: m.offset)
                age = observe.age_seconds(observe.sent_of(newest.headers))
                outage, recovery = tracker.sent(time.time(), age)
                if outage:
                    observe.UPLINK_OUTAGE.observe(outage.lasted)
                    log.warning("Link back after %.1f s down; catching up", outage.lasted)
                if recovery:
                    observe.UPLINK_CATCHUP.observe(recovery.catch_up)
                    log.warning(
                        "Caught up %.1f s after the link returned (it was down %.1f s)",
                        recovery.catch_up,
                        recovery.outage,
                    )
                observe.UPLINK_LINK_UP.set(1)
                observe.UPLINK_EVENTS.inc(sent)
                health.ready, health.detail = True, f"forwarding to {TARGET} ({tracker.state})"
                for msgs in batches.values():
                    for m in msgs:
                        observe.observe_freshness("uplink", m.headers)
            if time.monotonic() - last_backlog > 2:
                observe.UPLINK_BACKLOG.set(await backlog(consumer))
                last_backlog = time.monotonic()
    finally:
        await consumer.stop()
        await _drop(producer)


async def _forward(producer, batches) -> int:
    futures = []
    for msgs in batches.values():
        for m in msgs:
            futures.append(
                await producer.send(bus.RAW, m.value, key=m.key, headers=list(m.headers or ()))
            )
    await asyncio.gather(*futures)
    return len(futures)


async def _drop(producer) -> None:
    if producer is None:
        return
    with contextlib.suppress(TimeoutError, Exception):
        await asyncio.wait_for(producer.stop(), timeout=5)


def _down(health: Health, detail: str) -> None:
    tracker.failed(time.time())
    observe.UPLINK_LINK_UP.set(0)
    health.count("link_failures")
    # Still ready: the uplink is doing its job, which right now is buffering.
    health.detail = detail
    log.warning("uplink: %s; buffering on the trackside", detail)


# ---- The link, for drills ---------------------------------------------------------------------


class LinkRequest(BaseModel):
    enabled: bool = True
    latency_ms: int = Field(0, ge=0, le=10_000)
    bandwidth_kbps: int = Field(0, ge=0, le=1_000_000)


api = FastAPI(title="pitwall-uplink")


@api.get("/link")
async def link_state() -> dict:
    async with httpx.AsyncClient(timeout=5) as client:
        proxy = (await client.get(f"{TOXIPROXY}/proxies/{PROXY}")).json()
    last = tracker.history[-1] if tracker.history else None
    return {
        "enabled": proxy.get("enabled"),
        "toxics": [{"type": t["type"], **t["attributes"]} for t in proxy.get("toxics", [])],
        "uplink": tracker.state,
        "last_recovery": (
            {"outage_s": round(last.outage, 1), "catch_up_s": round(last.catch_up, 1)}
            if last
            else None
        ),
    }


@api.post("/link")
async def set_link(request: LinkRequest) -> dict:
    if os.environ.get("PITWALL_FAULTS", "").lower() not in {"1", "true", "yes"}:
        raise HTTPException(403, "Link drills are off (PITWALL_FAULTS)")
    async with httpx.AsyncClient(timeout=5) as client:
        proxy = (await client.get(f"{TOXIPROXY}/proxies/{PROXY}")).json()
        for toxic in proxy.get("toxics", []):
            await client.delete(f"{TOXIPROXY}/proxies/{PROXY}/toxics/{toxic['name']}")
        if request.latency_ms:
            await client.post(
                f"{TOXIPROXY}/proxies/{PROXY}/toxics",
                json={
                    "name": "latency",
                    "type": "latency",
                    "stream": "downstream",
                    "attributes": {
                        "latency": request.latency_ms,
                        "jitter": request.latency_ms // 10,
                    },
                },
            )
        if request.bandwidth_kbps:
            await client.post(
                f"{TOXIPROXY}/proxies/{PROXY}/toxics",
                json={
                    "name": "bandwidth",
                    "type": "bandwidth",
                    "stream": "upstream",
                    "attributes": {"rate": request.bandwidth_kbps},
                },
            )
        await client.post(f"{TOXIPROXY}/proxies/{PROXY}", json={"enabled": request.enabled})
    observe.LINK_ENABLED.set(1 if request.enabled else 0)
    log.warning(
        "DRILL: link %s (latency %d ms, bandwidth %s)",
        "up" if request.enabled else "CUT",
        request.latency_ms,
        f"{request.bandwidth_kbps} KB/s" if request.bandwidth_kbps else "unlimited",
    )
    return await link_state()


app = service_app("uplink", work, api)
