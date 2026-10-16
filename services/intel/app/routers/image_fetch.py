"""POST /v1/image-fetch (BF-038): one image of a crawled site, through the SSRF guard, for the API to store.

The API never downloads crawled URLs itself (security.md §4): it asks here, gets the bytes back as
`application/octet-stream`, and sniffs, measures and processes them. Only `image/*` responses are accepted,
capped at the request's `maxBytes`; redirects are re-checked hop by hop by the fetcher.
"""

from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, Request, Response

from app.contracts.image_fetch_request import ImageFetchRequest
from app.contracts.problem_details import Code
from app.errors import IntelError
from app.net.safe_fetch import (
    BlockedDestinationError,
    FetchError,
    FetchPolicy,
    ResponseTooLargeError,
    SafeFetcher,
)
from app.security.internal_auth import require_internal_auth

router = APIRouter(prefix="/v1", tags=["image-fetch"], dependencies=[Depends(require_internal_auth)])
logger: structlog.stdlib.BoundLogger = structlog.get_logger("bf-intel.image_fetch")


def get_fetcher(request: Request) -> SafeFetcher:
    fetcher: SafeFetcher = request.app.state.safe_fetcher
    return fetcher


@router.post("/image-fetch", response_class=Response)
async def image_fetch(
    body: ImageFetchRequest, fetcher: Annotated[SafeFetcher, Depends(get_fetcher)]
) -> Response:
    """Downloads one image (http/https, public addresses, `image/*`, at most `maxBytes`): its bytes."""
    # Any type is read (an error page is reported as the upstream's status); the type is checked after.
    policy = FetchPolicy(timeout_seconds=float(body.timeoutSeconds), max_bytes=body.maxBytes)
    try:
        result = await fetcher.fetch(str(body.url), headers={"Accept": "image/*"}, policy=policy)
    except BlockedDestinationError as error:
        raise IntelError(Code.VALIDATION_FAILED, f"Refused destination: {error}") from None
    except ResponseTooLargeError as error:
        raise IntelError(Code.VALIDATION_FAILED, str(error)) from None
    except FetchError as error:
        logger.info("image_fetch_failed", reason=type(error).__name__)
        raise IntelError(Code.EXTERNAL_SERVICE_FAILED, type(error).__name__) from None
    if not 200 <= result.status_code < 300:
        raise IntelError(Code.EXTERNAL_SERVICE_FAILED, f"The image answered HTTP {result.status_code}")
    if not (result.media_type or "").startswith("image/"):
        raise IntelError(Code.VALIDATION_FAILED, f"Not an image: {result.media_type or 'no content type'}")
    return Response(
        content=result.content,
        media_type="application/octet-stream",
        headers={"X-Image-Media-Type": result.media_type or "", "Cache-Control": "no-store"},
    )
