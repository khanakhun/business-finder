"""OpenTelemetry tracing: W3C trace context in, OTLP/HTTP out when `OTEL_EXPORTER_OTLP_ENDPOINT` is set."""

from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from app.logging import SERVICE_NAME
from app.settings import Settings

# Probes and scrapes would drown real traces (same exclusions as the API). The instrumentation matches these
# regexes with re.search against the full URL, so they are anchored on the path.
EXCLUDED_URLS = r"^[a-z]+://[^/]+/health/(live|ready)/?(\?.*)?$,^[a-z]+://[^/]+/metrics/?(\?.*)?$"


def create_tracer_provider(settings: Settings) -> TracerProvider:
    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": SERVICE_NAME,
                "service.version": settings.app_version,
                "deployment.environment.name": settings.node_env,
            }
        )
    )
    if settings.otel_exporter_otlp_endpoint is not None:
        endpoint = str(settings.otel_exporter_otlp_endpoint).rstrip("/")
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces")))
    return provider


def install_global_tracer_provider(provider: TracerProvider) -> None:
    """Libraries that use the global API (httpx instrumentation, later Crawl4AI) report to this provider."""
    trace.set_tracer_provider(provider)


def instrument_app(app: FastAPI, provider: TracerProvider) -> None:
    FastAPIInstrumentor.instrument_app(app, tracer_provider=provider, excluded_urls=EXCLUDED_URLS)
