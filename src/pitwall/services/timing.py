"""timing: keeps the live timing board (positions, gaps, laps, tyres, flags) and publishes it to
pitwall.board up to four times a second."""

from __future__ import annotations

from pitwall import bus
from pitwall.services import Health, defect, service_app
from pitwall.services.projector import project
from pitwall.timing import Board


class WrongGapsBoard(Board):
    """A rehearsed bad release: gaps 50% too big. Nothing crashes and nothing is slow; only a
    comparison with the version already running can tell."""

    def snapshot(self) -> dict:
        board = super().snapshot()
        for car in board["cars"]:
            for field in ("gap_to_leader", "interval"):
                if isinstance(car[field], int | float):
                    car[field] = round(car[field] * 1.5, 3)
        return board


async def work(health: Health) -> None:
    await project(
        health,
        WrongGapsBoard() if defect() == "wrong-gaps" else Board(),
        group="timing",
        sources=(bus.TIMING, bus.RACE),
        target=bus.BOARD,
        key=b"board",
        every=0.25,
    )


app = service_app("timing", work)
