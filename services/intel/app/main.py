"""Application factory. Run with `python -m app.serve` (or `uv run task dev`); uvicorn calls create_app()."""

from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.trace import TracerProvider

from app.concurrency import CpuPool
from app.errors import install_error_handlers
from app.health import HealthIndicator
from app.logging import configure_logging
from app.metrics import Metrics
from app.middleware import RequestContextMiddleware
from app.net.safe_fetch import FetchPolicy, SafeFetcher, strip_query_from_span
from app.routers import echo, health, open_data, site_intel
from app.security.internal_auth import InternalAuthenticator, InternalAuthMiddleware
from app.services.open_data.releases import ReleaseResolver
from app.services.open_data.service import OpenDataService
from app.services.site_intel.browser import BrowserPool
from app.services.site_intel.service import SiteIntelService
from app.services.site_intel.storage import S3ArtifactStore
from app.settings import Settings, get_settings
from app.telemetry import create_tracer_provider, install_global_tracer_provider, instrument_app


def create_app(
    settings: Settings | None = None,
    *,
    tracer_provider: TracerProvider | None = None,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    health_indicators: Sequence[HealthIndicator] = (),
    open_data_service: OpenDataService | None = None,
    site_intel_service: SiteIntelService | None = None,
) -> FastAPI:
    """Tests pass settings, a tracer provider with an in-memory exporter, a fixed clock, fake indicators and
    an open-data service reading local fixtures."""
    settings = settings or get_settings()
    logger = configure_logging(level=settings.log_level, env=settings.node_env, version=settings.app_version)
    owns_provider = tracer_provider is None
    if tracer_provider is None:
        tracer_provider = create_tracer_provider(settings)
        install_global_tracer_provider(tracer_provider)
    metrics = Metrics()
    cpu_pool = CpuPool(settings.intel_cpu_workers)
    fetcher = SafeFetcher(
        FetchPolicy(
            timeout_seconds=settings.intel_fetch_timeout_seconds,
            max_bytes=settings.intel_fetch_max_bytes,
        )
    )
    site_fetcher, browsers, site_intel_service = _site_intel(settings, clock, site_intel_service)
    for client in (fetcher.client, site_fetcher.client):
        HTTPXClientInstrumentor.instrument_client(
            client, tracer_provider=tracer_provider, request_hook=strip_query_from_span
        )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        logger.info("intel service started", port=settings.intel_port, workers=settings.intel_workers)
        if settings.intel_workers > 1:
            logger.warning("several workers: metrics and the replay cache are per process; prefer replicas")
        try:
            yield
        finally:
            # Each step runs even if an earlier one fails.
            try:
                await fetcher.aclose()
                await _close_site_intel(site_fetcher, browsers)
            finally:
                try:
                    await cpu_pool.aclose()
                finally:
                    if owns_provider:
                        tracer_provider.shutdown()  # flushes pending spans
                    else:
                        tracer_provider.force_flush()
                    logger.info("intel service stopped")

    production = settings.node_env == "production"
    app = FastAPI(
        title="Business Finder intel",
        version=settings.app_version,
        lifespan=lifespan,
        # Internal service: the schema is useful while developing, not something to publish.
        openapi_url=None if production else "/openapi.json",
        docs_url=None if production else "/docs",
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.metrics = metrics
    app.state.cpu_pool = cpu_pool
    app.state.safe_fetcher = fetcher
    app.state.clock = clock
    app.state.health_indicators = [*health_indicators, *_browser_indicator(settings, browsers)]
    app.state.site_intel = site_intel_service
    app.state.open_data = open_data_service or OpenDataService(
        settings,
        ReleaseResolver(
            stac_url=str(settings.overture_stac_url),
            pinned_overture=settings.overture_release,
            foursquare=settings.foursquare_release,
        ),
    )

    install_error_handlers(app)
    for router in (health.router, echo.router, open_data.router, site_intel.router):
        app.include_router(router)
    # Last added = outermost: tracing → request context (id, log, metrics) → internal auth → routing.
    app.add_middleware(
        InternalAuthMiddleware,
        authenticator=InternalAuthenticator(settings.intel_shared_secret.get_secret_value().encode()),
        max_body_bytes=settings.intel_max_request_bytes,
    )
    app.add_middleware(RequestContextMiddleware, metrics=metrics)
    instrument_app(app, tracer_provider)
    return app


def _site_intel(
    settings: Settings, clock: Callable[[], datetime], service: SiteIntelService | None
) -> tuple[SafeFetcher, BrowserPool | None, SiteIntelService]:
    """The website crawler (BF-026): its own fetcher (it identifies itself to robots.txt) and browser pool."""
    site_fetcher = SafeFetcher(
        FetchPolicy(
            timeout_seconds=settings.intel_fetch_timeout_seconds, max_bytes=settings.intel_fetch_max_bytes
        ),
        user_agent=settings.site_intel_user_agent,
    )
    if service is not None:
        return site_fetcher, None, service
    browsers = BrowserPool(
        site_fetcher,
        max_contexts=settings.site_intel_max_contexts,
        sandbox=settings.site_intel_chromium_sandbox,
        resource_policy=FetchPolicy(
            timeout_seconds=settings.site_intel_resource_timeout_seconds,
            max_bytes=settings.site_intel_resource_max_bytes,
            follow_redirects=False,
        ),
    )
    service = SiteIntelService(
        browsers=browsers,
        fetcher=site_fetcher,
        store=S3ArtifactStore(settings),
        user_agent=settings.site_intel_user_agent,
        fetch_policy=FetchPolicy(timeout_seconds=10, max_bytes=settings.intel_fetch_max_bytes),
        clock=clock,
    )
    return site_fetcher, browsers, service


def _browser_indicator(settings: Settings, browsers: BrowserPool | None) -> list[HealthIndicator]:
    if browsers is None or not settings.site_intel_browser_check:
        return []
    return [HealthIndicator("browser", browsers.ready)]


async def _close_site_intel(fetcher: SafeFetcher, browsers: BrowserPool | None) -> None:
    try:
        await fetcher.aclose()
    finally:
        if browsers is not None:
            await browsers.aclose()
