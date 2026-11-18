"""A small, polite client for OpenF1 (https://openf1.org), the free source of historical race data.

OpenF1 is unofficial and run by volunteers: one request at a time, a pause between requests, and
backing off when it says it's busy.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

import httpx

BASE_URL = "https://api.openf1.org/v1"
RETRY_STATUSES = {429, 500, 502, 503, 504}


class OpenF1Error(RuntimeError):
    pass


class OpenF1:
    def __init__(
        self,
        base_url: str = BASE_URL,
        *,
        pause: float = 0.35,
        attempts: int = 5,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._http = httpx.Client(
            base_url=base_url,
            timeout=httpx.Timeout(120, connect=15),
            transport=transport,
            headers={"User-Agent": "pitwall-replayer/0.1"},
        )
        self._pause = pause
        self._attempts = attempts
        self._sleep = sleep
        self._last = 0.0

    def get(self, endpoint: str, **params: Any) -> list[dict]:
        """One OpenF1 endpoint as a list of rows. Retries busy or failing responses with backoff."""
        for attempt in range(self._attempts):
            wait = self._pause - (time.monotonic() - self._last)
            if wait > 0:
                self._sleep(wait)
            try:
                response = self._http.get(f"/{endpoint}", params=params)
            except httpx.TransportError as error:
                problem = f"{type(error).__name__}: {error}"
            else:
                self._last = time.monotonic()
                if response.status_code == 200:
                    rows = response.json()
                    if not isinstance(rows, list):
                        raise OpenF1Error(f"/{endpoint} returned {type(rows).__name__}, not a list")
                    return rows
                if response.status_code == 404:
                    return []  # OpenF1 answers "no results" with a 404
                if response.status_code not in RETRY_STATUSES:
                    raise OpenF1Error(f"/{endpoint} failed: HTTP {response.status_code}")
                problem = f"HTTP {response.status_code}"
            if attempt + 1 < self._attempts:
                self._sleep(2 ** (attempt + 1))
        raise OpenF1Error(f"/{endpoint} kept failing ({problem}) after {self._attempts} attempts")

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> OpenF1:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
