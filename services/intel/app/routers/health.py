from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from app.health import aggregate_health
from app.metrics import CONTENT_TYPE_LATEST, Metrics

router = APIRouter(tags=["health"])


@router.get("/health/live")
async def live() -> dict[str, str]:
    """Answers as long as the process runs."""
    return {"status": "up"}


@router.get("/health/ready")
async def ready(request: Request) -> JSONResponse:
    """503 when a critical dependency is down: the crawler's browser (BF-026) must start."""
    report = await aggregate_health(request.app.state.health_indicators)
    return JSONResponse(report, status_code=503 if report["status"] == "down" else 200)


@router.get("/metrics", include_in_schema=False)
async def metrics(request: Request) -> Response:
    registry: Metrics = request.app.state.metrics
    return Response(registry.render(), media_type=CONTENT_TYPE_LATEST)
