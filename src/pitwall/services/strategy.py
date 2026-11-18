"""strategy: tyre stints, pace, degradation and pit loss, published to pitwall.strategy once a
second."""

from __future__ import annotations

from pitwall import bus
from pitwall.services import Health, service_app
from pitwall.services.projector import project
from pitwall.strategy import Strategy


async def work(health: Health) -> None:
    await project(
        health,
        Strategy(),
        group="strategy",
        sources=(bus.TIMING, bus.RACE),
        target=bus.STRATEGY,
        key=b"strategy",
        every=1.0,
    )


app = service_app("strategy", work)
