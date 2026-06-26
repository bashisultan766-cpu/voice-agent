"""
Optional OpenTelemetry tracing — disabled by default (OTEL_ENABLED=false).
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Any, Iterator, Optional

logger = logging.getLogger(__name__)

_tracer: Any = None
_initialized = False


def _ensure_tracer() -> Any:
    global _tracer, _initialized
    if _initialized:
        return _tracer
    _initialized = True
    try:
        from ..config import get_settings

        settings = get_settings()
        if not getattr(settings, "OTEL_ENABLED", False):
            return None
        endpoint = (getattr(settings, "OTEL_EXPORTER_OTLP_ENDPOINT", "") or "").strip()
        if endpoint:
            try:
                from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
                from opentelemetry.sdk.resources import Resource
                from opentelemetry.sdk.trace import TracerProvider
                from opentelemetry.sdk.trace.export import BatchSpanProcessor
                from opentelemetry import trace

                resource = Resource.create({"service.name": "twilio-voice-agent"})
                provider = TracerProvider(resource=resource)
                exporter = OTLPSpanExporter(endpoint=endpoint)
                provider.add_span_processor(BatchSpanProcessor(exporter))
                trace.set_tracer_provider(provider)
            except ImportError:
                logger.warning("otel_packages_missing — tracing disabled")
                return None
        from opentelemetry import trace

        _tracer = trace.get_tracer("twilio-voice-agent")
        return _tracer
    except Exception as exc:
        logger.warning("otel_init_failed err=%s", type(exc).__name__)
        return None


@contextmanager
def span(name: str, **attributes: Any) -> Iterator[Optional[Any]]:
    """Create a trace span when OTEL is enabled; no-op otherwise."""
    tracer = _ensure_tracer()
    if tracer is None:
        yield None
        return
    with tracer.start_as_current_span(name) as s:
        for key, val in attributes.items():
            if val is not None:
                s.set_attribute(key, val)
        yield s


def reset_otel_for_tests() -> None:
    global _tracer, _initialized
    _tracer = None
    _initialized = False
