import json
import string
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from hypothesis import given
from hypothesis import strategies as st
from starlette.types import Message, Receive, Scope, Send

from app.errors import install_error_handlers
from app.routers import echo
from app.security.internal_auth import (
    AuthenticationError,
    InternalAuthenticator,
    InternalAuthMiddleware,
    NonceCache,
    canonical_string,
    sign,
)
from tests.conftest import NOW, REPO, SECRET, Signer

VECTORS = json.loads((REPO / "packages/contracts/fixtures/internal-auth-vectors.json").read_text())


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=lambda v: v["name"])
def test_matches_the_typescript_signer(vector: dict[str, object]) -> None:
    """Same inputs as packages/contracts/src/internal-auth.test.ts → identical strings and signatures."""
    body = str(vector.get("body") or "").encode()
    fields = {
        "timestamp": vector["timestamp"],
        "nonce": vector["nonce"],
        "method": vector["method"],
        "path": vector["path"],
        "body": body,
    }
    assert canonical_string(**fields) == vector["canonical"]  # type: ignore[arg-type]
    assert sign(VECTORS["secret"].encode(), **fields) == vector["authorization"]  # type: ignore[arg-type]
    # …and the verifier accepts the TypeScript-produced header.
    verifier = InternalAuthenticator(VECTORS["secret"].encode(), clock=lambda: float(vector["timestamp"]))  # type: ignore[arg-type]
    verifier.verify(
        str(vector["authorization"]), method=str(vector["method"]), path=str(vector["path"]), body=body
    )


def make_verifier(now: float = 1_000_000.0) -> InternalAuthenticator:
    return InternalAuthenticator(b"s" * 32, clock=lambda: now)


def header(ts: int = 1_000_000, nonce: str = "n" * 22, body: bytes = b"{}", secret: bytes = b"s" * 32) -> str:
    return sign(secret, timestamp=ts, nonce=nonce, method="POST", path="/v1/echo", body=body)


def verify(verifier: InternalAuthenticator, authorization: str | None, body: bytes = b"{}") -> None:
    verifier.verify(authorization, method="POST", path="/v1/echo", body=body)


class TestVerifier:
    def test_accepts_a_fresh_signature_within_the_skew(self) -> None:
        verify(make_verifier(), header(ts=1_000_000 - 60))
        verify(make_verifier(), header(ts=1_000_000 + 60, nonce="m" * 22))

    @pytest.mark.parametrize(
        ("authorization", "reason"),
        [
            (None, "malformed"),
            ("", "malformed"),
            ("Basic abc", "malformed"),
            ("Bearer 1.short.abc", "malformed"),
            (header().replace("Bearer ", "bearer "), "malformed"),
            (header(ts=1_000_000 - 61), "skew"),
            (header(ts=1_000_000 + 61), "skew"),
            (header(secret=b"x" * 32), "signature"),
            (header(body=b'{"a":1}'), "signature"),
        ],
    )
    def test_rejects(self, authorization: str | None, reason: str) -> None:
        with pytest.raises(AuthenticationError, match=reason):
            verify(make_verifier(), authorization)

    def test_signature_covers_method_path_and_query(self) -> None:
        verifier = make_verifier()
        good = header()
        for method, path in [("PUT", "/v1/echo"), ("POST", "/v1/echo?x=1"), ("POST", "/v1/other")]:
            with pytest.raises(AuthenticationError, match="signature"):
                verifier.verify(good, method=method, path=path, body=b"{}")

    def test_rejects_a_replayed_nonce(self) -> None:
        verifier = make_verifier()
        verify(verifier, header())
        with pytest.raises(AuthenticationError, match="replayed"):
            verify(verifier, header())

    @given(position=st.integers(min_value=0, max_value=63), char=st.sampled_from(string.hexdigits.lower()))
    def test_any_changed_signature_digit_is_rejected(self, position: int, char: str) -> None:
        good = header()
        signature = good[-64:]
        if signature[position] == char:
            return
        tampered = good[:-64] + signature[:position] + char + signature[position + 1 :]
        with pytest.raises(AuthenticationError, match="signature"):
            verify(make_verifier(), tampered)


class TestNonceCache:
    def test_forgets_nonces_after_the_ttl(self) -> None:
        cache = NonceCache(ttl_seconds=120)
        assert cache.add_if_new("a", now=0)
        assert not cache.add_if_new("a", now=119)
        assert cache.add_if_new("a", now=120)
        assert len(cache) == 1

    def test_fails_closed_when_full(self) -> None:
        cache = NonceCache(ttl_seconds=120, max_entries=2)
        assert cache.add_if_new("a", now=0)
        assert cache.add_if_new("b", now=0)
        with pytest.raises(AuthenticationError, match="full"):
            cache.add_if_new("c", now=1)
        assert cache.add_if_new("c", now=200)  # expired entries make room


class TestEndpoint:
    def test_signed_request_is_accepted(self, client: TestClient, signed: Signer) -> None:
        body = b'{"message":"hello"}'
        response = client.post("/v1/echo", content=body, headers=signed("POST", "/v1/echo", body))
        assert response.status_code == 200
        assert response.json() == {"message": "hello", "receivedAt": "2026-10-15T12:00:00Z"}

    def test_query_string_is_part_of_the_signature(self, client: TestClient, signed: Signer) -> None:
        body = b'{"message":"hi"}'
        ok = client.post(
            "/v1/echo?trace=a%20b", content=body, headers=signed("POST", "/v1/echo?trace=a%20b", body)
        )
        assert ok.status_code == 200
        bad = client.post(
            "/v1/echo?trace=other", content=body, headers=signed("POST", "/v1/echo?trace=a%20b", body)
        )
        assert bad.status_code == 401

    def test_unsigned_request_gets_a_401_problem(self, client: TestClient) -> None:
        response = client.post("/v1/echo", json={"message": "hello"})
        assert response.status_code == 401
        assert response.headers["content-type"] == "application/problem+json"
        assert response.headers["www-authenticate"] == "Bearer"
        problem = response.json()
        assert problem["code"] == "UNAUTHENTICATED"
        assert problem["type"] == "https://errors.business-finder.dev/UNAUTHENTICATED"
        assert problem["instance"] == "/v1/echo"
        assert problem["detail"] == "A valid internal signature is required."  # no hint which check failed

    def test_replayed_request_is_rejected(self, client: TestClient, signed: Signer) -> None:
        body = b'{"message":"hello"}'
        headers = signed("POST", "/v1/echo", body)
        assert client.post("/v1/echo", content=body, headers=headers).status_code == 200
        assert client.post("/v1/echo", content=body, headers=headers).status_code == 401

    @pytest.mark.parametrize("body", [b'{"wrong": true}', b"{not json", b""])
    def test_auth_runs_before_parsing_and_validation(self, client: TestClient, body: bytes) -> None:
        """An unauthenticated caller learns nothing about request schemas (no 422 with field paths)."""
        response = client.post("/v1/echo", content=body, headers={"Content-Type": "application/json"})
        assert response.status_code == 401
        assert "errors" not in response.json()

    def test_oversized_bodies_are_refused_before_authentication(
        self, client: TestClient, signed: Signer
    ) -> None:
        body = b'{"message":"' + b"x" * 1_048_576 + b'"}'
        response = client.post("/v1/echo", content=body, headers=signed("POST", "/v1/echo", body))
        assert response.status_code == 413
        assert response.json()["code"] == "VALIDATION_FAILED"

    def test_health_and_metrics_need_no_signature(self, client: TestClient) -> None:
        assert client.get("/health/ready").status_code == 200
        assert client.get("/metrics").status_code == 200


class TestMiddleware:
    """Raw ASGI cases TestClient cannot produce (chunked bodies without Content-Length)."""

    @staticmethod
    async def call(app: object, chunks: list[bytes], headers: list[tuple[bytes, bytes]]) -> list[Message]:
        scope = {
            "type": "http",
            "method": "POST",
            "path": "/v1/echo",
            "raw_path": b"/v1/echo",
            "query_string": b"",
            "headers": headers,
        }
        incoming = [
            {"type": "http.request", "body": c, "more_body": i < len(chunks) - 1}
            for i, c in enumerate(chunks)
        ]
        sent: list[Message] = []

        async def receive() -> Message:
            return incoming.pop(0) if incoming else {"type": "http.disconnect"}

        async def send(message: Message) -> None:
            sent.append(message)

        await app(scope, receive, send)  # type: ignore[operator]
        return sent

    async def test_counts_streamed_bytes_without_content_length(self) -> None:
        reached = False

        async def downstream(scope: Scope, receive: Receive, send: Send) -> None:
            nonlocal reached
            reached = True

        middleware = InternalAuthMiddleware(
            downstream, authenticator=InternalAuthenticator(SECRET.encode()), max_body_bytes=10
        )
        sent = await self.call(middleware, [b"x" * 6, b"x" * 6], [])
        assert sent[0]["status"] == 413
        assert not reached

    async def test_replays_the_verified_body_to_the_application(self) -> None:
        received: list[Message] = []

        async def downstream(scope: Scope, receive: Receive, send: Send) -> None:
            received.append(await receive())
            assert scope["state"]["internal_auth"] is True

        body = b'{"message":"hi"}'
        authorization = sign(
            SECRET.encode(),
            timestamp=int(time.time()),
            nonce="n" * 22,
            method="POST",
            path="/v1/echo",
            body=body,
        )
        middleware = InternalAuthMiddleware(
            downstream, authenticator=InternalAuthenticator(SECRET.encode()), max_body_bytes=1_000
        )
        await self.call(middleware, [body[:5], body[5:]], [(b"authorization", authorization.encode())])
        assert received == [{"type": "http.request", "body": body, "more_body": False}]


def test_protected_router_outside_the_middleware_fails_closed() -> None:
    """Mounting a /v1 router on an app without InternalAuthMiddleware must not serve unauthenticated calls."""
    bare = FastAPI()
    install_error_handlers(bare)
    bare.state.clock = lambda: NOW
    bare.include_router(echo.router)
    with TestClient(bare) as client:
        response = client.post("/v1/echo", json={"message": "hi"})
    assert response.status_code == 401
