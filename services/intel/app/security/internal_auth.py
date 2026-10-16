"""Verifies `Authorization: Bearer <unix_ts>.<nonce>.<hex_hmac>` on internal calls (ADR-0002).

The signed string is `ts|nonce|METHOD|path?query|hex(sha256(body))`, HMAC-SHA256 with `INTEL_SHARED_SECRET`.
The TypeScript signer is `signInternalRequest` in `@bf/contracts`; both are tested against
`packages/contracts/fixtures/internal-auth-vectors.json`.
"""

import hashlib
import hmac
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable

import structlog
from fastapi import Request
from starlette.datastructures import Headers
from starlette.requests import ClientDisconnect
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.contracts.problem_details import Code
from app.errors import IntelError, problem, send_problem

MAX_SKEW_SECONDS = 60  # INTERNAL_AUTH_MAX_SKEW_SECONDS in @bf/contracts
_TOKEN = re.compile(r"Bearer (\d{1,12})\.([A-Za-z0-9_-]{16,64})\.([0-9a-f]{64})")

logger: structlog.stdlib.BoundLogger = structlog.get_logger("bf-intel.auth")


class AuthenticationError(Exception):
    """Why a request was rejected; logged, never sent to the caller (the 401 body is generic)."""


def canonical_string(*, timestamp: int, nonce: str, method: str, path: str, body: bytes) -> str:
    return "|".join((str(timestamp), nonce, method.upper(), path, hashlib.sha256(body).hexdigest()))


def sign(secret: bytes, *, timestamp: int, nonce: str, method: str, path: str, body: bytes) -> str:
    """Authorization header value; the Python twin of `signInternalRequest` (used by tests and tooling)."""
    message = canonical_string(timestamp=timestamp, nonce=nonce, method=method, path=path, body=body)
    signature = hmac.new(secret, message.encode(), hashlib.sha256).hexdigest()
    return f"Bearer {timestamp}.{nonce}.{signature}"


class NonceCache:
    """Remembers nonces for the skew window so a captured request cannot be replayed.

    In memory, per process: with several uvicorn workers a replay could reach another worker within the
    window. Acceptable on the internal network (BF-008 decision); a shared store can replace this later.
    """

    def __init__(self, ttl_seconds: float, max_entries: int = 100_000) -> None:
        self._ttl = ttl_seconds
        self._max = max_entries
        self._expiries: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()

    def add_if_new(self, nonce: str, now: float) -> bool:
        with self._lock:
            # Entries are inserted in time order, so expired ones are at the front.
            while self._expiries and next(iter(self._expiries.values())) <= now:
                self._expiries.popitem(last=False)
            if nonce in self._expiries:
                return False
            if len(self._expiries) >= self._max:
                # Only reachable with valid signatures (i.e. by a caller holding the secret): fail closed.
                raise AuthenticationError("nonce cache full")
            self._expiries[nonce] = now + self._ttl
            return True

    def __len__(self) -> int:
        return len(self._expiries)


class InternalAuthenticator:
    def __init__(
        self,
        secret: bytes,
        *,
        clock: Callable[[], float] = time.time,
        max_skew_seconds: int = MAX_SKEW_SECONDS,
        nonces: NonceCache | None = None,
    ) -> None:
        self._secret = secret
        self._clock = clock
        self._skew = max_skew_seconds
        # A nonce must outlive every timestamp that would still pass the skew check.
        self._nonces = nonces or NonceCache(ttl_seconds=2 * max_skew_seconds)

    def verify(self, authorization: str | None, *, method: str, path: str, body: bytes) -> None:
        """Raises `AuthenticationError` unless the header is a fresh, unreplayed signature of this request."""
        match = _TOKEN.fullmatch(authorization or "")
        if match is None:
            raise AuthenticationError("missing or malformed bearer token")
        timestamp, nonce, signature = int(match[1]), match[2], match[3]
        now = self._clock()
        if abs(now - timestamp) > self._skew:
            raise AuthenticationError("timestamp outside the allowed clock skew")
        expected = sign(self._secret, timestamp=timestamp, nonce=nonce, method=method, path=path, body=body)
        if not hmac.compare_digest(expected.rsplit(".", 1)[1], signature):
            raise AuthenticationError("signature mismatch")
        # After the signature check: unauthenticated traffic must not be able to fill the cache.
        if not self._nonces.add_if_new(nonce, now):
            raise AuthenticationError("nonce replayed")


def request_target(scope: Scope) -> str:
    """Path and query exactly as received (percent-encoding preserved), as the signer saw them."""
    raw_path: bytes = scope.get("raw_path") or scope["path"].encode()
    query: bytes = scope.get("query_string", b"")
    return (raw_path + (b"?" + query if query else b"")).decode("latin-1")


class _BodyTooLargeError(Exception):
    pass


_UNAUTHENTICATED_DETAIL = "A valid internal signature is required."  # never says which check failed
_AUTHENTICATED = "internal_auth"  # key in scope["state"] (request.state), set only by the middleware


class InternalAuthMiddleware:
    """Authenticates every request under `prefix` before routing (pure ASGI).

    It runs before FastAPI parses or validates anything, so an unsigned caller gets a 401 and learns nothing
    about request schemas, and it caps the body size before reading it. The verified body is replayed to the
    application unchanged.
    """

    def __init__(
        self, app: ASGIApp, *, authenticator: InternalAuthenticator, max_body_bytes: int, prefix: str = "/v1"
    ) -> None:
        self.app = app
        self.authenticator = authenticator
        self.max_body_bytes = max_body_bytes
        self.prefix = prefix

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path: str = scope.get("path", "")
        if scope["type"] != "http" or not (path == self.prefix or path.startswith(f"{self.prefix}/")):
            await self.app(scope, receive, send)
            return
        try:
            body = await self._read_body(scope, receive)
        except _BodyTooLargeError:
            too_large = f"The request body exceeds {self.max_body_bytes} bytes."
            body_problem = problem(Code.VALIDATION_FAILED, detail=too_large, instance=path, status=413)
            await send_problem(send, body_problem)
            return
        headers = Headers(scope=scope)
        try:
            self.authenticator.verify(
                headers.get("authorization"), method=scope["method"], path=request_target(scope), body=body
            )
        except AuthenticationError as error:
            logger.warning("internal auth rejected", reason=str(error), path=path)
            unauthenticated = problem(Code.UNAUTHENTICATED, detail=_UNAUTHENTICATED_DETAIL, instance=path)
            await send_problem(send, unauthenticated, {"WWW-Authenticate": "Bearer"})
            return
        scope.setdefault("state", {})[_AUTHENTICATED] = True
        replayed = False

        async def replay() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()  # http.disconnect

        await self.app(scope, replay, send)

    async def _read_body(self, scope: Scope, receive: Receive) -> bytes:
        declared = Headers(scope=scope).get("content-length", "")
        if declared.isdigit() and int(declared) > self.max_body_bytes:
            raise _BodyTooLargeError
        chunks: list[bytes] = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                raise ClientDisconnect
            chunk: bytes = message.get("body", b"")
            size += len(chunk)
            if size > self.max_body_bytes:
                raise _BodyTooLargeError
            chunks.append(chunk)
            if not message.get("more_body", False):
                return b"".join(chunks)


async def require_internal_auth(request: Request) -> None:
    """Router dependency: the route is reachable only through `InternalAuthMiddleware`.

    Declared on every `/v1` router so that mounting a protected router outside the middleware's prefix fails
    closed (401) instead of silently serving unauthenticated requests.
    """
    if getattr(request.state, _AUTHENTICATED, False) is not True:
        logger.error("protected route reached without InternalAuthMiddleware", path=request.url.path)
        raise IntelError(
            Code.UNAUTHENTICATED, _UNAUTHENTICATED_DETAIL, headers={"WWW-Authenticate": "Bearer"}
        )
