"""Distributed tracing through Kafka: one data point followed from the replayer to the browser.

The W3C ``traceparent`` travels in each message's headers. The replayer starts a trace for a
sample of events (every lap, pit stop and race-control message, and one telemetry sample in 200);
ingest, timing, strategy and the API each add a span and pass the context on. Tracing is off
unless OTEL_EXPORTER_OTLP_ENDPOINT is set, and then costs nothing for unsampled events.
"""

from __future__ import annotations

import os
import random
from contextlib import contextmanager

from opentelemetry import context, propagate, trace
from opentelemetry.trace import Span

TRACED_TYPES = {"lap.completed", "pit.stop", "race.control", "tyre.stint", "session.info"}
TELEMETRY_SAMPLE = 1 / 200

_enabled = False


def setup(service: str) -> None:
    """Exports spans over OTLP/HTTP to the collector, if one is configured."""
    global _enabled
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint or _enabled:
        return
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(
        resource=Resource.create(
            {"service.name": f"pitwall-{service}", "service.namespace": "pitwall"}
        )
    )
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    _enabled = True


def enabled() -> bool:
    return _enabled


def tracer():
    return trace.get_tracer("pitwall")


def should_trace(event: dict) -> bool:
    if not _enabled:
        return False
    kind = event.get("type")
    if kind in TRACED_TYPES:
        return True
    return kind in {"car.telemetry", "car.position"} and random.random() < TELEMETRY_SAMPLE


def _carrier(headers) -> dict[str, str]:
    return {k: v.decode() for k, v in headers or () if k in ("traceparent", "tracestate")}


def has_trace(headers) -> bool:
    return any(k == "traceparent" for k, _ in headers or ())


def inject(headers: list[tuple[str, bytes]]) -> list[tuple[str, bytes]]:
    """The headers with the current span's context in place of any earlier one."""
    carrier: dict[str, str] = {}
    propagate.inject(carrier)
    kept = [(k, v) for k, v in headers if k not in ("traceparent", "tracestate")]
    return kept + [(k, v.encode()) for k, v in carrier.items()]


@contextmanager
def span_from(headers, name: str, event: dict, **attributes):
    """A span continuing the trace carried in the message headers (if there is one)."""
    if not (_enabled and has_trace(headers)):
        yield None
        return
    token = context.attach(propagate.extract(_carrier(headers)))
    try:
        with tracer().start_as_current_span(name, kind=trace.SpanKind.CONSUMER) as span:
            _describe(span, event, attributes)
            yield span
    finally:
        context.detach(token)


@contextmanager
def root_span(name: str, event: dict, **attributes):
    with tracer().start_as_current_span(name, kind=trace.SpanKind.PRODUCER) as span:
        _describe(span, event, attributes)
        yield span


def _describe(span: Span, event: dict, attributes: dict) -> None:
    span.set_attribute("pitwall.event.type", event.get("type", ""))
    span.set_attribute("pitwall.race", event.get("race", ""))
    span.set_attribute("pitwall.seq", int(event.get("seq", -1)))
    if event.get("car") is not None:
        span.set_attribute("pitwall.car", int(event["car"]))
    for key, value in attributes.items():
        span.set_attribute(f"pitwall.{key}", value)
