from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

from app.settings import Settings
from app.telemetry import create_tracer_provider


def exporters(settings: Settings) -> list[object]:
    provider = create_tracer_provider(settings)
    processors = provider._active_span_processor._span_processors  # no public accessor
    return [getattr(p, "span_exporter", None) for p in processors]


def test_identifies_the_service(settings: Settings) -> None:
    attributes = create_tracer_provider(settings).resource.attributes
    assert attributes["service.name"] == "bf-intel"
    assert attributes["service.version"] == "0.0.0-dev"
    assert attributes["deployment.environment.name"] == "test"


def test_exports_only_when_an_endpoint_is_configured(settings: Settings) -> None:
    assert exporters(settings) == []
    configured = settings.model_copy(update={"otel_exporter_otlp_endpoint": "http://127.0.0.1:4318/"})
    [exporter] = exporters(configured)
    assert isinstance(exporter, OTLPSpanExporter)
    assert exporter._endpoint == "http://127.0.0.1:4318/v1/traces"
