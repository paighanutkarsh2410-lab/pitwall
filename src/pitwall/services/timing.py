"""timing: keeps the live timing board (positions, gaps, laps, tyres, flags) and publishes it to
pitwall.board up to four times a second."""

from __future__ import annotations

from pitwall import bus
from pitwall.services import Health, service_app
from pitwall.services.projector import project
from pitwall.timing import Board


async def work(health: Health) -> None:
    await project(
        health,
        Board(),
        group="timing",
        sources=(bus.TIMING, bus.RACE),
        target=bus.BOARD,
        key=b"board",
        every=0.25,
    )


app = service_app("timing", work)
