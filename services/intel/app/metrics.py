"""Prometheus metrics with the names, labels and buckets of `@bf/observability` (docs/OBSERVABILITY.md)."""

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Histogram,
    generate_latest,
)
from prometheus_client.gc_collector import GCCollector
from prometheus_client.platform_collector import PlatformCollector
from prometheus_client.process_collector import ProcessCollector

# LATENCY_BUCKETS_SECONDS in packages/observability/src/metrics.ts.
LATENCY_BUCKETS_SECONDS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60)

_METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"})

__all__ = ["CONTENT_TYPE_LATEST", "LATENCY_BUCKETS_SECONDS", "Metrics"]


class Metrics:
    """One registry per app instance (tests create several apps; the global registry rejects duplicates)."""

    def __init__(self) -> None:
        self.registry = CollectorRegistry()
        # Same default collectors as prometheus_client's global registry: process, platform and GC metrics.
        ProcessCollector(registry=self.registry)
        PlatformCollector(registry=self.registry)
        GCCollector(registry=self.registry)
        self.http_requests = Counter(
            "bf_http_requests_total",
            "HTTP requests handled, by route template and status class.",
            ["method", "route", "status"],
            registry=self.registry,
        )
        self.http_duration = Histogram(
            "bf_http_request_duration_seconds",
            "HTTP request duration, by route template.",
            ["method", "route"],
            buckets=LATENCY_BUCKETS_SECONDS,
            registry=self.registry,
        )

    def observe_request(self, *, method: str, route: str, status: int, seconds: float) -> None:
        # Clients choose the method token; unknown ones share one series (label cardinality stays bounded).
        method = method if method in _METHODS else "OTHER"
        self.http_requests.labels(method, route, f"{status // 100}xx").inc()
        self.http_duration.labels(method, route).observe(seconds)

    def render(self) -> bytes:
        return generate_latest(self.registry)
