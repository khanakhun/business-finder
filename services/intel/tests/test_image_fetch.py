"""POST /v1/image-fetch (BF-038): one image through the SSRF guard, bytes back, typed failures."""

import json
from collections.abc import Iterator
from ipaddress import ip_address

import pytest
import respx
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider

from app.main import create_app
from app.net.ip_policy import IPAddress
from app.net.safe_fetch import SafeFetcher
from app.settings import Settings
from tests.conftest import NOW, Signer

PUBLIC = "93.184.215.14"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


async def public_dns(host: str, port: int) -> list[IPAddress]:
    return [ip_address("10.0.0.5" if host == "intranet.example" else PUBLIC)]


@pytest.fixture
def api(settings: Settings, tracer_provider: TracerProvider) -> Iterator[TestClient]:
    app = create_app(settings, tracer_provider=tracer_provider, clock=lambda: NOW)
    with TestClient(app, raise_server_exceptions=False) as client:
        app.state.safe_fetcher = SafeFetcher(resolver=public_dns)
        yield client


@pytest.fixture
def mock() -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as router:
        router.route(host="testserver").pass_through()
        yield router


def post(api: TestClient, signed: Signer, payload: dict[str, object]) -> object:
    # The API always sends every field (the generated model has no defaults).
    body = json.dumps({"maxBytes": 15 * 1024 * 1024, "timeoutSeconds": 20, **payload}).encode()
    return api.post("/v1/image-fetch", content=body, headers=signed("POST", "/v1/image-fetch", body))


def test_returns_the_image_bytes(api: TestClient, signed: Signer, mock: respx.MockRouter) -> None:
    mock.get(f"https://{PUBLIC}/photo.png").respond(200, content=PNG, headers={"Content-Type": "image/png"})
    response = post(api, signed, {"url": "https://example.com/photo.png"})
    assert response.status_code == 200, response.text  # type: ignore[attr-defined]
    assert response.content == PNG  # type: ignore[attr-defined]
    assert response.headers["x-image-media-type"] == "image/png"  # type: ignore[attr-defined]


def test_refuses_what_is_not_an_image_or_too_large(
    api: TestClient, signed: Signer, mock: respx.MockRouter
) -> None:
    mock.get(f"https://{PUBLIC}/page").respond(200, text="<html>", headers={"Content-Type": "text/html"})
    mock.get(f"https://{PUBLIC}/big.png").respond(
        200, content=PNG * 100, headers={"Content-Type": "image/png"}
    )
    assert post(api, signed, {"url": "https://example.com/page"}).status_code == 422  # type: ignore[attr-defined]
    big = post(api, signed, {"url": "https://example.com/big.png", "maxBytes": 100})
    assert big.status_code == 422  # type: ignore[attr-defined]


def test_refuses_private_destinations_and_reports_upstream_errors(
    api: TestClient, signed: Signer, mock: respx.MockRouter
) -> None:
    blocked = post(api, signed, {"url": "https://intranet.example/x.png"})
    assert blocked.status_code == 422  # type: ignore[attr-defined]
    assert blocked.json()["code"] == "VALIDATION_FAILED"  # type: ignore[attr-defined]
    mock.get(f"https://{PUBLIC}/gone.png").respond(404)
    gone = post(api, signed, {"url": "https://example.com/gone.png"})
    assert gone.status_code == 502  # type: ignore[attr-defined]
    assert gone.json()["code"] == "EXTERNAL_SERVICE_FAILED"  # type: ignore[attr-defined]


def test_requires_internal_auth(api: TestClient) -> None:
    response = api.post("/v1/image-fetch", json={"url": "https://example.com/x.png"})
    assert response.status_code == 401
