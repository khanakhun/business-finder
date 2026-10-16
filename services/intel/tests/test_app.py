import asyncio
from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from app.contracts.problem_details import Code
from app.errors import IntelError
from app.health import HealthIndicator, aggregate_health
from app.main import create_app
from app.settings import Settings
from tests.conftest import Logs, Signer


class TestHealth:
    def test_live(self, client: TestClient) -> None:
        assert client.get("/health/live").json() == {"status": "up"}

    def test_ready_without_dependencies(self, client: TestClient) -> None:
        response = client.get("/health/ready")
        assert response.status_code == 200
        assert response.json() == {"status": "up", "checks": {}}

    @pytest.mark.parametrize(
        ("critical", "status", "http"),
        [(True, "down", 503), (False, "degraded", 200)],
    )
    def test_ready_reports_failing_dependencies(
        self, settings: Settings, tracer_provider: TracerProvider, critical: bool, status: str, http: int
    ) -> None:
        async def ok() -> dict[str, object]:
            return {"bucket": "bf-artifacts"}

        async def broken() -> None:
            raise ConnectionError("refused")

        indicators = [HealthIndicator("s3", ok), HealthIndicator("cache", broken, critical=critical)]
        app = create_app(settings, tracer_provider=tracer_provider, health_indicators=indicators)
        with TestClient(app) as client:
            response = client.get("/health/ready")
        assert response.status_code == http
        body = response.json()
        assert body["status"] == status
        assert body["checks"]["s3"]["details"] == {"bucket": "bf-artifacts"}
        assert body["checks"]["cache"] | {"durationMs": 0} == {
            "status": "down",
            "critical": critical,
            "error": "refused",
            "durationMs": 0,
        }

    def test_ready_starts_the_crawler_browser_unless_disabled(
        self, settings: Settings, tracer_provider: TracerProvider
    ) -> None:
        enabled = settings.model_copy(update={"site_intel_browser_check": True})
        app = create_app(enabled, tracer_provider=tracer_provider)
        assert [i.name for i in app.state.health_indicators] == ["browser"]
        assert create_app(settings, tracer_provider=tracer_provider).state.health_indicators == []

    async def test_a_timeout_inside_a_check_is_reported_as_its_own_error(self) -> None:
        async def client_timeout() -> None:
            raise TimeoutError("connect timeout")

        report = await aggregate_health([HealthIndicator("s3", client_timeout)], timeout_s=5)
        assert report["checks"]["s3"]["error"] == "connect timeout"  # type: ignore[index]

    async def test_checks_time_out(self) -> None:
        async def hang() -> None:
            await asyncio.Event().wait()

        report = await aggregate_health([HealthIndicator("slow", hang)], timeout_s=0.01)
        assert report["status"] == "down"
        assert report["checks"]["slow"]["error"] == "timed out after 10 ms"  # type: ignore[index]


class TestMetrics:
    def test_exposes_http_and_process_metrics(self, client: TestClient, signed: Signer) -> None:
        body = b'{"message":"m"}'
        client.post("/v1/echo", content=body, headers=signed("POST", "/v1/echo", body))
        client.get("/nope")
        text = client.get("/metrics").text
        assert 'bf_http_requests_total{method="POST",route="/v1/echo",status="2xx"} 1.0' in text
        assert 'bf_http_requests_total{method="GET",route="unmatched",status="4xx"} 1.0' in text
        assert 'bf_http_request_duration_seconds_bucket{le="0.005",method="POST",route="/v1/echo"}' in text
        assert "process_cpu_seconds_total" in text

    def test_unknown_methods_share_one_series(self, client: TestClient) -> None:
        for method in ("FOO", "BAR"):
            client.request(method, "/health/live")
        text = client.get("/metrics").text
        assert 'method="OTHER"' in text
        assert "FOO" not in text
        assert "BAR" not in text


class TestRequestContext:
    def test_echoes_a_safe_request_id(self, client: TestClient) -> None:
        response = client.get("/health/live", headers={"x-request-id": "req-123:abc"})
        assert response.headers["x-request-id"] == "req-123:abc"

    @pytest.mark.parametrize("value", ["", "has space", "x" * 129, "semi;colon"])
    def test_replaces_an_unsafe_request_id(self, client: TestClient, value: str) -> None:
        response = client.get("/health/live", headers={"x-request-id": value})
        assert response.headers["x-request-id"] != value
        assert len(response.headers["x-request-id"]) == 36

    def test_logs_one_line_per_request_with_trace_and_request_ids(
        self, client: TestClient, logs: Logs, spans: InMemorySpanExporter, signed: Signer
    ) -> None:
        trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
        body = b'{"message":"hello"}'
        headers = signed("POST", "/v1/echo", body) | {
            "traceparent": f"00-{trace_id}-00f067aa0ba902b7-01",
            "x-request-id": "r-1",
        }
        assert client.post("/v1/echo", content=body, headers=headers).status_code == 200
        line = next(e for e in logs.lines() if e["msg"] == "request completed")
        assert line | {"time": "t", "durationMs": 0, "spanId": "s"} == {
            "level": "info",
            "time": "t",
            "service": "bf-intel",
            "env": "test",
            "version": "0.0.0-dev",
            "traceId": trace_id,
            "spanId": "s",
            "requestId": "r-1",
            "method": "POST",
            "route": "/v1/echo",
            "status": 200,
            "durationMs": 0,
            "msg": "request completed",
        }
        server_span = next(s for s in spans.get_finished_spans() if s.name == "POST /v1/echo")
        assert format(server_span.context.trace_id, "032x") == trace_id

    def test_probes_are_not_logged_or_traced(
        self, client: TestClient, logs: Logs, spans: InMemorySpanExporter
    ) -> None:
        client.get("/health/live")
        client.get("/metrics")
        assert not [e for e in logs.lines() if e["msg"] == "request completed"]
        assert not spans.get_finished_spans()


@pytest.fixture
def failing_app(app: FastAPI) -> FastAPI:
    @app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("database password is hunter2")

    @app.get("/upstream")
    async def upstream() -> None:
        raise IntelError(Code.EXTERNAL_SERVICE_FAILED, "overture bucket returned 503 for key secret/x")

    @app.get("/stream")
    async def stream() -> StreamingResponse:
        async def chunks() -> AsyncIterator[bytes]:
            yield b"partial"
            raise RuntimeError("broke mid-stream")

        return StreamingResponse(chunks())

    @app.get("/debug/metrics-export")
    async def metrics_lookalike() -> dict[str, str]:
        return {"ok": "yes"}

    return app


class TestProblems:
    def test_unknown_route_is_a_404_problem(self, client: TestClient) -> None:
        response = client.get("/nope")
        assert response.status_code == 404
        assert response.headers["content-type"] == "application/problem+json"
        assert response.json() | {"traceId": None} == {
            "type": "https://errors.business-finder.dev/NOT_FOUND",
            "title": "Not found",
            "status": 404,
            "detail": "Not Found",
            "code": "NOT_FOUND",
            "instance": "/nope",
            "traceId": None,
        }

    def test_wrong_method_is_a_404_like_the_api(self, client: TestClient, signed: Signer) -> None:
        response = client.get("/v1/echo", headers=signed("GET", "/v1/echo"))
        assert response.status_code == 404
        assert "allow" not in response.headers
        assert response.json() | {"traceId": None} == {
            "type": "https://errors.business-finder.dev/NOT_FOUND",
            "title": "Not found",
            "status": 404,
            "detail": "Not Found",
            "code": "NOT_FOUND",
            "instance": "/v1/echo",
            "traceId": None,
        }

    def test_invalid_body_is_a_422_problem_with_field_errors(
        self, client: TestClient, signed: Signer
    ) -> None:
        body = b'{"message":""}'
        response = client.post("/v1/echo", content=body, headers=signed("POST", "/v1/echo", body))
        assert response.status_code == 422
        problem = response.json()
        assert problem["code"] == "VALIDATION_FAILED"
        assert problem["errors"] == [
            {"path": ["message"], "message": "String should have at least 1 character"}
        ]

    def test_unhandled_errors_do_not_leak(self, failing_app: FastAPI, logs: Logs) -> None:
        with TestClient(failing_app, raise_server_exceptions=False) as client:
            response = client.get("/boom", headers={"x-request-id": "r-boom"})
        assert response.status_code == 500
        assert response.headers["content-type"] == "application/problem+json"
        assert response.headers["x-request-id"] == "r-boom"
        problem = response.json()
        assert problem["code"] == "INTERNAL"
        assert problem["detail"] == "Internal error"
        assert "hunter2" not in response.text
        error_line = next(e for e in logs.lines() if e["msg"] == "unhandled error")
        assert error_line["level"] == "error"
        assert error_line["requestId"] == "r-boom"
        assert error_line["err"]["type"] == "RuntimeError"  # type: ignore[index]

    def test_handled_server_errors_are_logged_and_traced_but_not_returned(
        self, failing_app: FastAPI, logs: Logs, spans: InMemorySpanExporter
    ) -> None:
        with TestClient(failing_app) as client:
            response = client.get("/upstream")
        assert response.status_code == 502
        assert response.json()["detail"] == "External service failed"
        line = next(e for e in logs.lines() if e["msg"] == "request failed")
        assert line["err"]["message"] == "overture bucket returned 503 for key secret/x"  # type: ignore[index]
        server_span = next(s for s in spans.get_finished_spans() if s.name == "GET /upstream")
        assert [e.name for e in server_span.events] == ["exception"]

    def test_an_error_after_the_response_started_is_logged_and_the_stream_aborted(
        self, failing_app: FastAPI, logs: Logs
    ) -> None:
        # Too late for a problem response: the middleware logs and re-raises so the server aborts the stream
        # (TestClient swallows the re-raised error with raise_server_exceptions=False).
        with TestClient(failing_app, raise_server_exceptions=False) as client:
            response = client.get("/stream")
        assert response.status_code == 200
        line = next(e for e in logs.lines() if e["msg"] == "unhandled error")
        assert line["err"]["message"] == "broke mid-stream"  # type: ignore[index]

    def test_only_probe_paths_are_excluded_from_tracing(
        self, failing_app: FastAPI, spans: InMemorySpanExporter
    ) -> None:
        with TestClient(failing_app) as client:
            client.get("/debug/metrics-export")
            client.get("/metrics?x=1")
        assert [s.name for s in spans.get_finished_spans() if s.kind.name == "SERVER"] == [
            "GET /debug/metrics-export"
        ]


class TestDocs:
    def test_openapi_only_outside_production(
        self, settings: Settings, tracer_provider: TracerProvider, client: TestClient
    ) -> None:
        assert "/v1/echo" in client.get("/openapi.json").json()["paths"]
        production = create_app(
            settings.model_copy(update={"node_env": "production"}), tracer_provider=tracer_provider
        )
        with TestClient(production) as prod_client:
            assert prod_client.get("/openapi.json").status_code == 404
            assert prod_client.get("/docs").status_code == 404
