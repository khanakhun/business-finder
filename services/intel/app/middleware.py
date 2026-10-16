"""Per-request context: request id (echoed as `x-request-id`), one access log line, HTTP metrics."""

import re
import time
import uuid

import structlog
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.contracts.problem_details import Code
from app.errors import problem
from app.metrics import Metrics

REQUEST_ID_HEADER = "x-request-id"
_SAFE_REQUEST_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}")  # same rule as the API (request-context.ts)

logger: structlog.stdlib.BoundLogger = structlog.get_logger("bf-intel.http")


def resolve_request_id(header: str | None) -> str:
    return header if header and _SAFE_REQUEST_ID.fullmatch(header) else str(uuid.uuid4())


class RequestContextMiddleware:
    """Pure ASGI (no BaseHTTPMiddleware): it must not buffer bodies or break streaming responses."""

    def __init__(self, app: ASGIApp, metrics: Metrics) -> None:
        self.app = app
        self.metrics = metrics

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope["headers"]}
        request_id = resolve_request_id(headers.get(REQUEST_ID_HEADER))
        status = 500
        started_response = False
        started = time.perf_counter()

        async def send_with_id(message: Message) -> None:
            nonlocal status, started_response
            if message["type"] == "http.response.start":
                status, started_response = message["status"], True
                message["headers"] = [*message.get("headers", []), (b"x-request-id", request_id.encode())]
            await send(message)

        with structlog.contextvars.bound_contextvars(requestId=request_id):
            try:
                await self.app(scope, receive, send_with_id)
            except Exception:
                logger.exception("unhandled error", path=scope["path"])
                if started_response:
                    raise  # Too late for a problem response; let the server close the connection.
                await self._send_internal_error(scope, send_with_id)
            finally:
                seconds = time.perf_counter() - started
                route = scope.get("route")
                template = getattr(route, "path", None) or "unmatched"
                self.metrics.observe_request(
                    method=scope["method"], route=template, status=status, seconds=seconds
                )
                if template not in ("/health/live", "/health/ready", "/metrics"):
                    logger.info(
                        "request completed",
                        method=scope["method"],
                        route=template,
                        status=status,
                        durationMs=round(seconds * 1000),
                    )

    @staticmethod
    async def _send_internal_error(scope: Scope, send: Send) -> None:
        body = problem(Code.INTERNAL, instance=scope["path"]).model_dump_json(exclude_none=True).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 500,
                "headers": [
                    (b"content-type", b"application/problem+json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
