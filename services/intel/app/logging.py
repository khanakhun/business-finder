"""Structured JSON logs with the same fields and redaction as `@bf/observability` (docs/OBSERVABILITY.md).

Lines look like `{"level":"info","time":"…Z","service":"bf-intel","env":…,"version":…,"traceId":…,"msg":…}`.
Standard-library loggers (uvicorn, httpx) are routed through the same pipeline.
"""

import json
import logging
import sys
from collections.abc import Callable, Mapping, MutableMapping
from typing import Any, TextIO

import structlog
from opentelemetry import trace

from app.settings import LogLevel

SERVICE_NAME = "bf-intel"
REDACTED = "[redacted]"
_MAX_DEPTH = 12

# Same list as SENSITIVE_KEYS in packages/observability/src/logger.ts (normalised: lowercase, no `_`/`-`),
# plus `setcookie` and `body.html`/`body.text`, which the TS logger covers with exact paths.
_SENSITIVE_KEYS = frozenset(
    {
        "password",
        "passwd",
        "secret",
        "clientsecret",
        "token",
        "accesstoken",
        "refreshtoken",
        "idtoken",
        "apikey",
        "authorization",
        "cookie",
        "setcookie",
        "privatekey",
        "credentials",
    }
)
_SENSITIVE_PATHS = frozenset({("body", "html"), ("body", "text")})

_LEVELS: dict[LogLevel, int] = {
    "trace": 5,
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "error": logging.ERROR,
    "fatal": logging.CRITICAL,
}
# Fields printed first, in pino's order; everything else follows, `msg` last.
_LEADING = ("level", "time", "service", "env", "version", "traceId", "spanId", "requestId")
# Extras uvicorn attaches for its coloured console output.
_DROPPED = frozenset({"color_message"})
# structlog method names → the labels pino prints.
_LABELS = {"warning": "warn", "critical": "fatal", "exception": "error"}


def _normalise(key: str) -> str:
    return key.lower().replace("_", "").replace("-", "")


def redact(value: object, path: tuple[str, ...] = (), depth: int = 0) -> object:
    """Copy of `value` with sensitive keys (at any depth, inside lists too) replaced by `[redacted]`."""
    if depth >= _MAX_DEPTH:
        return REDACTED
    if isinstance(value, Mapping):
        out: dict[str, object] = {}
        for key, item in value.items():
            name = str(key)
            child = (*path, name)
            sensitive = _normalise(name) in _SENSITIVE_KEYS or child[-2:] in _SENSITIVE_PATHS
            out[name] = REDACTED if sensitive else redact(item, child, depth + 1)
        return out
    if isinstance(value, list | tuple):
        return [redact(item, path, depth + 1) for item in value]
    return value


def _redact_event(_: object, __: str, event: MutableMapping[str, Any]) -> Mapping[str, Any]:
    redacted = redact(event)
    assert isinstance(redacted, dict)  # noqa: S101 — a mapping in, a dict out
    return redacted


def _add_trace(_: object, __: str, event: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    context = trace.get_current_span().get_span_context()
    if context.is_valid:
        event.setdefault("traceId", format(context.trace_id, "032x"))
        event.setdefault("spanId", format(context.span_id, "016x"))
    return event


def _label_level(_: object, method: str, event: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    level = str(event.get("level", method)).lower()
    event["level"] = _LABELS.get(level, level)
    return event


def _serialise_error(_: object, __: str, event: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    """`err: {type, message, stack}` like pino's err serializer."""
    exc_info = event.pop("exc_info", None)
    error = event.get("err")
    if exc_info is True:
        exc_info = sys.exc_info()
    if isinstance(exc_info, BaseException):
        error = exc_info
    elif isinstance(exc_info, tuple) and isinstance(exc_info[1], BaseException):
        error = exc_info[1]
    if isinstance(error, BaseException):
        event["err"] = {
            "type": type(error).__name__,
            "message": str(error),
            "stack": structlog.processors.format_exc_info(
                None, "", {"exc_info": (type(error), error, error.__traceback__)}
            ).get("exception", ""),
        }
    return event


def _finalise(_: object, __: str, event: MutableMapping[str, Any]) -> Mapping[str, Any]:
    ordered = {key: event.pop(key) for key in _LEADING if key in event}
    message = event.pop("msg", None)
    ordered |= {k: v for k, v in event.items() if k not in _DROPPED}
    return ordered | ({"msg": message} if message is not None else {})


def _dumps(value: object, *, default: Callable[[object], object] | None = None, **_: object) -> str:
    """Compact JSON like pino (structlog passes `default=` for non-JSON values)."""
    return json.dumps(value, separators=(",", ":"), default=default)


def configure_logging(
    *, level: LogLevel, env: str, version: str, stream: TextIO | None = None
) -> structlog.stdlib.BoundLogger:
    """Configures structlog and the standard library root logger; returns the service logger."""
    static = {"service": SERVICE_NAME, "env": env, "version": version}

    def add_static(_: object, __: str, event: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
        for key, value in static.items():
            event.setdefault(key, value)
        return event

    shared: list[structlog.typing.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        _label_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True, key="time"),
        add_static,
        _add_trace,
        _serialise_error,
        _redact_event,
    ]
    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            *shared,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=False,
    )
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=[structlog.stdlib.ExtraAdder(), *shared],
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.EventRenamer("msg"),
            _finalise,
            structlog.processors.JSONRenderer(serializer=_dumps),
        ],
    )
    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(_LEVELS[level])
    # httpx logs every request URL at INFO, and fetched URLs may carry tokens (safe_fetch logs its own).
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
    # We log one structured line per request ourselves (middleware); uvicorn's access log would duplicate it.
    logging.getLogger("uvicorn.access").disabled = True
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).handlers.clear()
        logging.getLogger(name).propagate = True
    logger: structlog.stdlib.BoundLogger = structlog.get_logger(SERVICE_NAME)
    return logger
