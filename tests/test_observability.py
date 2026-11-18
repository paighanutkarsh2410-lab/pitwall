import asyncio

import pytest
from fastapi.testclient import TestClient
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from pitwall import observe, tracing
from pitwall.services import service_app


def test_freshness_is_measured_from_the_send_header(monkeypatch):
    monkeypatch.setattr(observe, "now_ms", lambda: 10_750)
    headers = [("pitwall-run", b"r"), (observe.SENT_HEADER, b"10000")]
    assert observe.sent_of(headers) == 10_000
    assert observe.age_seconds(10_000) == 0.75
    before = observe.FRESHNESS.labels("test")._sum.get()
    observe.observe_freshness("test", headers)
    assert observe.FRESHNESS.labels("test")._sum.get() - before == pytest.approx(0.75)
    observe.observe_freshness("test", [("pitwall-run", b"r")])  # no header: nothing measured
    assert observe.sent_of([(observe.SENT_HEADER, b"garbage")]) is None


@pytest.fixture
def spans(monkeypatch):
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(tracing, "_enabled", True)
    monkeypatch.setattr(tracing, "tracer", lambda: provider.get_tracer("test"))
    return exporter


EVENT = {"type": "pit.stop", "race": "2024-sao-paulo", "seq": 7, "car": 1, "data": {}}


def test_one_trace_follows_an_event_through_every_hop(spans):
    headers = [("pitwall-run", b"r")]
    with tracing.root_span("replayer.send", EVENT):
        headers = tracing.inject(headers)
    assert tracing.has_trace(headers)
    with tracing.span_from(headers, "ingest.route", EVENT) as span:
        assert span is not None
        forwarded = tracing.inject(headers)
    with tracing.span_from(forwarded, "timing.apply", EVENT):
        pass
    finished = {s.name: s for s in spans.get_finished_spans()}
    assert set(finished) == {"replayer.send", "ingest.route", "timing.apply"}
    trace_ids = {s.context.trace_id for s in finished.values()}
    assert len(trace_ids) == 1  # one trace, end to end
    assert finished["timing.apply"].parent.span_id == finished["ingest.route"].context.span_id
    assert finished["ingest.route"].attributes["pitwall.car"] == 1
    assert [k for k, _ in forwarded].count("traceparent") == 1  # replaced, not appended


def test_untraced_events_cost_nothing(spans):
    with tracing.span_from([("pitwall-run", b"r")], "ingest.route", EVENT) as span:
        assert span is None
    assert spans.get_finished_spans() == ()


def test_only_a_sample_of_telemetry_is_traced(monkeypatch):
    monkeypatch.setattr(tracing, "_enabled", True)
    assert tracing.should_trace({"type": "lap.completed"})
    monkeypatch.setattr(tracing.random, "random", lambda: 0.5)
    assert not tracing.should_trace({"type": "car.telemetry"})
    monkeypatch.setattr(tracing.random, "random", lambda: 0.001)
    assert tracing.should_trace({"type": "car.telemetry"})
    monkeypatch.setattr(tracing, "_enabled", False)
    assert not tracing.should_trace({"type": "lap.completed"})


async def idle(health):
    health.ready = True
    await asyncio.Event().wait()


def test_every_service_exports_metrics_and_guards_its_fault_switch(monkeypatch):
    monkeypatch.delenv("PITWALL_FAULTS", raising=False)
    app = service_app("drill", idle)
    with TestClient(app) as client:
        assert client.post("/faults", json={"delay_ms": 500}).status_code == 403
        monkeypatch.setenv("PITWALL_FAULTS", "true")
        assert client.post("/faults", json={"delay_ms": 500}).json()["delay_ms"] == 500
        assert client.get("/faults").json()["delay_ms"] == 500
        metrics = client.get("/metrics/").text
        assert 'pitwall_fault_delay_seconds{service="drill"} 0.5' in metrics
        assert "pitwall_event_freshness_seconds_bucket" in metrics
        client.post("/faults", json={"delay_ms": 0})


def test_tracing_stays_off_without_a_collector(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.setattr(tracing, "_enabled", False)
    tracing.setup("x")
    assert not tracing.enabled()
    assert isinstance(trace.get_tracer_provider(), trace.ProxyTracerProvider | TracerProvider)
