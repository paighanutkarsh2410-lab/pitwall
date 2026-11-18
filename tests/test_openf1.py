import httpx
import pytest

from pitwall.openf1 import OpenF1, OpenF1Error


def client(handler, sleeps: list[float]) -> OpenF1:
    return OpenF1(pause=0, transport=httpx.MockTransport(handler), sleep=sleeps.append)


def test_backs_off_while_openf1_is_busy(fake, api):
    sleeps: list[float] = []
    api._sleep = sleeps.append
    fake.busy["drivers"] = 2
    rows = api.get("drivers", session_key=9636)
    assert {r["name_acronym"] for r in rows} == {"VER", "NOR"}
    assert fake.requests["drivers"] == 3
    assert sleeps == [2, 4]  # exponential backoff


def test_no_results_is_an_empty_list(api):
    assert api.get("team_radio", session_key=9636) == []


def test_gives_up_after_the_last_attempt():
    sleeps: list[float] = []
    api = client(lambda request: httpx.Response(503), sleeps)
    with pytest.raises(OpenF1Error, match=r"kept failing \(HTTP 503\) after 5 attempts"):
        api.get("laps")
    assert sleeps == [2, 4, 8, 16]


def test_does_not_retry_a_bad_request():
    sleeps: list[float] = []
    api = client(lambda request: httpx.Response(400), sleeps)
    with pytest.raises(OpenF1Error, match="HTTP 400"):
        api.get("laps")
    assert sleeps == []


def test_retries_a_dropped_connection():
    calls = []

    def flaky(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("connection reset")
        return httpx.Response(200, json=[{"ok": True}])

    assert client(flaky, []).get("laps") == [{"ok": True}]
