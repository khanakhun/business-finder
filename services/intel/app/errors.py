"""RFC 9457 problem+json responses matching `ProblemDetailsSchema` and the `@bf/contracts` error registry."""

from collections.abc import Mapping

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from opentelemetry import trace
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import Send

from app.contracts.error_codes import ERROR_CODES, ERROR_TYPE_BASE
from app.contracts.problem_details import Code, Error, ProblemDetails

PROBLEM_JSON = "application/problem+json"

logger: structlog.stdlib.BoundLogger = structlog.get_logger("bf-intel.errors")

# Framework-raised HTTP errors (routing, method) mapped to the closest registry code.
_STATUS_CODES: Mapping[int, Code] = {
    401: Code.UNAUTHENTICATED,
    403: Code.FORBIDDEN,
    404: Code.NOT_FOUND,
    409: Code.CONFLICT,
    429: Code.RATE_LIMITED,
}


class IntelError(Exception):
    """Typed error crossing a layer boundary; mapped to problem+json once, by `install_error_handlers`."""

    def __init__(
        self, code: Code, detail: str | None = None, *, headers: Mapping[str, str] | None = None
    ) -> None:
        super().__init__(detail or ERROR_CODES[code].title)
        self.code = code
        self.detail = detail
        self.headers = dict(headers or {})


def _trace_id() -> str | None:
    context = trace.get_current_span().get_span_context()
    return format(context.trace_id, "032x") if context.is_valid else None


def problem(
    code: Code,
    *,
    detail: str | None = None,
    instance: str | None = None,
    status: int | None = None,
    errors: list[Error] | None = None,
) -> ProblemDetails:
    info = ERROR_CODES[code]
    status = status or info.status
    return ProblemDetails.model_validate(
        {
            "type": f"{ERROR_TYPE_BASE}{code.value}",
            "title": info.title,
            "status": status,
            # 5xx details are replaced so internals never leak (api.md §4).
            "detail": info.title if status >= 500 else (detail or info.title),
            "code": code,
            "instance": instance,
            "traceId": _trace_id(),
            "errors": errors,
        }
    )


def problem_response(body: ProblemDetails, headers: Mapping[str, str] | None = None) -> JSONResponse:
    return JSONResponse(
        body.model_dump(mode="json", exclude_none=True),
        status_code=body.status,
        media_type=PROBLEM_JSON,
        headers=dict(headers or {}),
    )


async def send_problem(send: Send, body: ProblemDetails, headers: Mapping[str, str] | None = None) -> None:
    """Writes a problem response from raw ASGI code (middleware runs before FastAPI's handlers)."""
    payload = body.model_dump_json(exclude_none=True).encode()
    raw_headers = [
        (b"content-type", PROBLEM_JSON.encode()),
        (b"content-length", str(len(payload)).encode()),
        *((k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or {}).items()),
    ]
    await send({"type": "http.response.start", "status": body.status, "headers": raw_headers})
    await send({"type": "http.response.body", "body": payload})


def _report_server_error(request: Request, error: Exception, status: int) -> None:
    """5xx details never reach the caller (`problem` replaces them), so they must reach logs and the trace."""
    if status >= 500:
        trace.get_current_span().record_exception(error)
        logger.error("request failed", err=error, path=request.url.path, status=status)


def install_error_handlers(app: FastAPI) -> None:
    async def on_intel_error(request: Request, error: Exception) -> JSONResponse:
        assert isinstance(error, IntelError)  # noqa: S101 — registered for IntelError only
        body = problem(error.code, detail=error.detail, instance=request.url.path)
        _report_server_error(request, error, body.status)
        return problem_response(body, error.headers)

    async def on_validation_error(request: Request, error: Exception) -> JSONResponse:
        assert isinstance(error, RequestValidationError)  # noqa: S101
        errors = [
            Error(path=[p for p in issue["loc"] if p != "body"], message=issue["msg"])
            for issue in error.errors()
        ]
        body = problem(
            Code.VALIDATION_FAILED, detail="The request is invalid.", instance=request.url.path, errors=errors
        )
        return problem_response(body)

    async def on_http_error(request: Request, error: Exception) -> JSONResponse:
        assert isinstance(error, StarletteHTTPException)  # noqa: S101
        status = error.status_code
        headers = error.headers
        if status == 405:
            # Same as the API (Express answers 404 for an unrouted method): there is no "method" error code.
            status, headers = 404, None
        code = _STATUS_CODES.get(status, Code.INTERNAL if status >= 500 else Code.VALIDATION_FAILED)
        detail = "Not Found" if status == 404 else str(error.detail)
        body = problem(code, detail=detail, instance=request.url.path, status=status)
        _report_server_error(request, error, status)
        return problem_response(body, headers)

    app.add_exception_handler(IntelError, on_intel_error)
    app.add_exception_handler(RequestValidationError, on_validation_error)
    app.add_exception_handler(StarletteHTTPException, on_http_error)
    # Unhandled exceptions become 500 problems in RequestContextMiddleware: Starlette's catch-all handler runs
    # outside user middleware (no request id) and re-raises, which would log every error twice.
