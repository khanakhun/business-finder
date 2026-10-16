from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.contracts.open_data_search_request import OpenDataSearchRequest
from app.contracts.open_data_search_response import OpenDataSearchResponse
from app.security.internal_auth import require_internal_auth
from app.services.open_data.service import OpenDataService

router = APIRouter(prefix="/v1/open-data", tags=["open-data"], dependencies=[Depends(require_internal_auth)])


def get_open_data(request: Request) -> OpenDataService:
    service: OpenDataService = request.app.state.open_data
    return service


@router.post("/places/search")
async def search_places(
    body: OpenDataSearchRequest, service: Annotated[OpenDataService, Depends(get_open_data)]
) -> OpenDataSearchResponse:
    """Overture / Foursquare places in an area (bbox or polygon), optionally filtered by categories."""
    return OpenDataSearchResponse.model_validate(await service.search(body))
