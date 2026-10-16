import io
import json
import logging

import structlog
from opentelemetry.sdk.trace import TracerProvider

from app.logging import REDACTED, configure_logging, redact


def capture() -> tuple[structlog.stdlib.BoundLogger, io.StringIO]:
    stream = io.StringIO()
    logger = configure_logging(level="info", env="test", version="1.2.3", stream=stream)
    return logger, stream


def lines(stream: io.StringIO) -> list[dict[str, object]]:
    return [json.loads(line) for line in stream.getvalue().splitlines()]


def test_writes_pino_compatible_json() -> None:
    logger, stream = capture()
    logger.warning("cache miss", key="k1")
    [line] = lines(stream)
    assert line | {"time": "t"} == {
        "level": "warn",
        "time": "t",
        "service": "bf-intel",
        "env": "test",
        "version": "1.2.3",
        "key": "k1",
        "msg": "cache miss",
    }
    assert str(line["time"]).endswith("Z")
    assert list(line) == ["level", "time", "service", "env", "version", "key", "msg"]
    assert stream.getvalue().startswith('{"level":"warn","time":')


def test_filters_below_the_configured_level() -> None:
    logger, stream = capture()
    logger.debug("hidden")
    assert lines(stream) == []


def test_redacts_sensitive_keys_at_any_depth() -> None:
    logger, stream = capture()
    logger.info(
        "outbound call",
        headers={"Authorization": "Bearer abc", "Set-Cookie": "s=1", "accept": "json"},
        config={"providers": [{"name": "google", "api_key": "AIza-secret"}], "clientSecret": "x"},
        body={"html": "<p>private</p>", "subject": "Hi"},
        password="hunter2",
    )
    [line] = lines(stream)
    assert line["headers"] == {"Authorization": REDACTED, "Set-Cookie": REDACTED, "accept": "json"}
    assert line["config"] == {
        "providers": [{"name": "google", "api_key": REDACTED}],
        "clientSecret": REDACTED,
    }
    assert line["body"] == {"html": REDACTED, "subject": "Hi"}
    assert line["password"] == REDACTED
    assert "hunter2" not in stream.getvalue()
    assert "AIza-secret" not in stream.getvalue()


def test_redact_stops_at_a_maximum_depth() -> None:
    nested: dict[str, object] = {"v": 1}
    for _ in range(20):
        nested = {"n": nested}
    assert REDACTED in json.dumps(redact(nested))


def test_serialises_errors_like_pino() -> None:
    logger, stream = capture()
    try:
        raise ValueError("bad input")
    except ValueError:
        logger.exception("failed")
    [line] = lines(stream)
    assert line["level"] == "error"
    err = line["err"]
    assert isinstance(err, dict)
    assert err["type"] == "ValueError"
    assert err["message"] == "bad input"
    assert "Traceback" in err["stack"]


def test_adds_the_active_trace_and_span_ids() -> None:
    logger, stream = capture()
    tracer = TracerProvider().get_tracer("test")
    with tracer.start_as_current_span("work") as span:
        logger.info("inside")
    context = span.get_span_context()
    [line] = lines(stream)
    assert line["traceId"] == format(context.trace_id, "032x")
    assert line["spanId"] == format(context.span_id, "016x")


def test_routes_standard_library_loggers_through_the_same_pipeline() -> None:
    _, stream = capture()
    logging.getLogger("uvicorn.error").info("server started", extra={"color_message": "\x1b[36mstarted"})
    logging.getLogger("uvicorn.access").info("GET / 200")  # disabled: the middleware logs requests
    [line] = lines(stream)
    assert line["msg"] == "server started"
    assert line["service"] == "bf-intel"
    assert line["level"] == "info"
    assert "color_message" not in line
