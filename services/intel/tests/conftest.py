import io
import json
import logging
import os
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from app.logging import configure_logging
from app.main import create_app
from app.security.internal_auth import sign
from app.settings import Settings

REPO = Path(__file__).resolve().parents[3]
SECRET = "test-secret-for-intel-unit-tests-0123456789"
NOW = datetime(2026, 10, 15, 12, 0, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _restore_logging() -> Iterator[None]:
    """create_app/configure_logging replace process-wide logging state; give it back after each test."""
    root = logging.getLogger()
    saved = (root.handlers[:], root.level)
    named = {
        n: logging.getLogger(n) for n in ("uvicorn", "uvicorn.error", "uvicorn.access", "httpx", "httpcore")
    }
    saved_named = {n: (lg.handlers[:], lg.level, lg.propagate, lg.disabled) for n, lg in named.items()}
    yield
    root.handlers[:], level = saved
    root.setLevel(level)
    for name, (handlers, lvl, propagate, disabled) in saved_named.items():
        logger = named[name]
        logger.handlers[:] = handlers
        logger.setLevel(lvl)
        logger.propagate, logger.disabled = propagate, disabled


@pytest.fixture
def settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    # A developer's shell or .env must not leak into tests.
    for name in list(os.environ):
        if name.startswith(("INTEL_", "S3_", "OTEL_")) or name in ("NODE_ENV", "LOG_LEVEL", "APP_VERSION"):
            monkeypatch.delenv(name)
    return Settings(
        _env_file=None,
        node_env="test",
        log_level="debug",
        intel_shared_secret=SECRET,
        s3_endpoint="http://127.0.0.1:9000",
        s3_access_key_id="test",
        s3_secret_access_key="test-secret",
        site_intel_browser_check=False,  # covered by its own test; most apps here never use the browser
    )


@pytest.fixture
def spans() -> InMemorySpanExporter:
    return InMemorySpanExporter()


@pytest.fixture
def tracer_provider(spans: InMemorySpanExporter) -> TracerProvider:
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(spans))
    return provider


@pytest.fixture
def app(settings: Settings, tracer_provider: TracerProvider) -> FastAPI:
    return create_app(settings, tracer_provider=tracer_provider, clock=lambda: NOW)


@dataclass
class Logs:
    stream: io.StringIO

    def lines(self) -> list[dict[str, object]]:
        return [json.loads(line) for line in self.stream.getvalue().splitlines() if line.strip()]


@pytest.fixture
def logs(settings: Settings, app: FastAPI) -> Logs:
    """Re-points the app's logging (configured by create_app) at a buffer."""
    stream = io.StringIO()
    configure_logging(level="debug", env=settings.node_env, version=settings.app_version, stream=stream)
    return Logs(stream)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


type Signer = Callable[..., dict[str, str]]


@pytest.fixture
def signed() -> Signer:
    """Headers for a request signed now with the test secret."""
    counter = iter(range(1_000_000))

    def make(method: str, path: str, body: bytes = b"", *, timestamp: int | None = None) -> dict[str, str]:
        ts = int(datetime.now(UTC).timestamp()) if timestamp is None else timestamp
        nonce = f"test-nonce-{next(counter):010d}"
        authorization = sign(SECRET.encode(), timestamp=ts, nonce=nonce, method=method, path=path, body=body)
        return {"Authorization": authorization, "Content-Type": "application/json"}

    return make
