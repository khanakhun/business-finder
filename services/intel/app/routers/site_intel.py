from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.contracts.site_intel import SiteIntel
from app.contracts.site_intel_request import SiteIntelRequest
from app.metrics import Metrics
from app.security.internal_auth import require_internal_auth
from app.services.site_intel.service import SiteIntelService

router = APIRouter(prefix="/v1", tags=["site-intel"], dependencies=[Depends(require_internal_auth)])


def get_site_intel(request: Request) -> SiteIntelService:
    service: SiteIntelService = request.app.state.site_intel
    return service


@router.post("/site-intel")
async def site_intel(
    body: SiteIntelRequest, request: Request, service: Annotated[SiteIntelService, Depends(get_site_intel)]
) -> SiteIntel:
    """Crawls a business website (home + key pages) and returns what it says: contacts, tools, languages,
    tech, freshness, no-solicitation statements, screenshots and page markdown (keys in object storage).
    Unreachable or blocked sites are an answer (`reachability`), not an error."""
    result, cached = await service.analyse(body)
    if not cached:  # a cache hit crawled nothing
        metrics: Metrics = request.app.state.metrics
        metrics.site_intel_results.labels(result.reachability.value).inc()
        metrics.site_intel_duration.observe(result.durationMs / 1000)
        metrics.site_intel_pages.inc(len(result.pages))
    return result
