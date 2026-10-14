"""Readiness aggregation with the same report shape as `aggregateHealth` in `@bf/observability`."""

import asyncio
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Literal

type Status = Literal["up", "down"]


@dataclass(frozen=True, slots=True)
class HealthIndicator:
    """A dependency check. A failing critical dependency makes the service `down`; others only `degraded`."""

    name: str
    check: Callable[[], Awaitable[dict[str, object] | None]]
    critical: bool = True


async def aggregate_health(
    indicators: Sequence[HealthIndicator], *, timeout_s: float = 2.0
) -> dict[str, object]:
    """Runs every check concurrently with a timeout; failures are reported in the body, never raised."""

    async def run(indicator: HealthIndicator) -> tuple[str, dict[str, object]]:
        started = time.perf_counter()
        result: dict[str, object] = {"critical": indicator.critical}
        deadline = asyncio.timeout(timeout_s)
        try:
            async with deadline:
                details = await indicator.check()
            result["status"] = "up"
            if details:
                result["details"] = details
        except Exception as error:  # a failing dependency is reported, not raised
            # A TimeoutError raised inside the check (socket, client) is that check's own error.
            message = f"timed out after {round(timeout_s * 1000)} ms" if deadline.expired() else str(error)
            result |= {"status": "down", "error": message or type(error).__name__}
        result["durationMs"] = round((time.perf_counter() - started) * 1000)
        return indicator.name, result

    checks = dict(await asyncio.gather(*(run(i) for i in indicators)))
    failing = [c for c in checks.values() if c["status"] == "down"]
    status = "down" if any(c["critical"] for c in failing) else "degraded" if failing else "up"
    return {"status": status, "checks": checks}
