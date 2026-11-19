"""Delivery guarantees between the trackside and the factory: nothing lost, nothing twice.

The uplink forwards the trackside stream to the factory at least once: after a broken link it
re-sends everything the factory hasn't confirmed, so some events can arrive twice. To make that
exactly-once *in effect*, the replayer numbers each key's events (a car, or "race") per run in
a ``pitwall-keyseq`` header, and ingest drops any number it has already seen. A number that
jumps ahead means events went missing; ingest counts them, which is how "nothing lost" is
measured rather than assumed.

Pure logic with no I/O, so the guarantees are unit-tested.
"""

from __future__ import annotations

from dataclasses import dataclass, field

KEYSEQ_HEADER = "pitwall-keyseq"


class KeySequencer:
    """Numbers each key's events 0, 1, 2, ... within one run (the replayer's side)."""

    def __init__(self) -> None:
        self.next: dict[bytes, int] = {}

    def number(self, key: bytes) -> int:
        n = self.next.get(key, 0)
        self.next[key] = n + 1
        return n


def keyseq_of(headers) -> int | None:
    for name, value in headers or ():
        if name == KEYSEQ_HEADER:
            try:
                return int(value)
            except ValueError:
                return None
    return None


@dataclass
class Verdict:
    duplicate: bool = False
    missing: int = 0  # events skipped over: lost somewhere upstream


class Deduplicator:
    """Ingest's side: has this key's event been seen before in this run? Did any go missing?

    Only the newest run is remembered: a key's events all go to one partition, which one ingest
    pod owns, so this pod sees every event of the keys it owns, in order.
    """

    def __init__(self) -> None:
        self.run: str | None = None
        self.last: dict[bytes, int] = {}

    def check(self, run: str | None, key: bytes | None, seq: int | None) -> Verdict:
        if run is None or key is None or seq is None:
            return Verdict()  # not numbered (an older producer): nothing to check
        if run != self.run:
            if self.run is not None and run < self.run:
                return Verdict()  # a straggler from an older run: not this run's business
            self.run, self.last = run, {}
        last = self.last.get(key)
        if last is not None and seq <= last:
            return Verdict(duplicate=True)
        self.last[key] = seq
        expected = 0 if last is None else last + 1
        # The first event seen for a key after a restart or a rebalance may start mid-run.
        missing = seq - expected if last is not None and seq > expected else 0
        return Verdict(missing=missing)


@dataclass
class Outage:
    lasted: float  # seconds the link was down
    restored_at: float


@dataclass
class Recovery:
    outage: float  # seconds the link was down
    catch_up: float  # seconds from the link coming back to the stream being current again


@dataclass
class LinkTracker:
    """Follows the uplink through outages: up, then down, then catching up, then up again.

    Caught up means: after a batch the factory confirmed, nothing is left unread on any trackside
    partition. (Offsets of different partitions can't be compared, so "the newest event looks
    fresh" is not enough: one partition can be current while another is still backlogged.)
    """

    state: str = "up"
    last_ok: float | None = None
    down_since: float | None = None
    restored_at: float | None = None
    outage: float = 0.0
    history: list[Recovery] = field(default_factory=list)

    def failed(self, now: float) -> Outage | None:
        if self.state == "down":
            return None
        if self.state == "up":
            # The link went down some time after the last successful send.
            self.down_since = self.last_ok if self.last_ok is not None else now
        self.state = "down"
        return None

    def sent(self, now: float, drained: bool) -> tuple[Outage | None, Recovery | None]:
        """A batch reached the factory. ``drained``: nothing is left unread at the track."""
        outage = recovery = None
        if self.state == "down":
            self.outage = now - (self.down_since or now)
            self.restored_at = now
            self.state = "catching_up"
            outage = Outage(self.outage, now)
        if self.state == "catching_up" and drained:
            recovery = Recovery(self.outage, now - (self.restored_at or now))
            self.history.append(recovery)
            self.state = "up"
        self.last_ok = now
        return outage, recovery
