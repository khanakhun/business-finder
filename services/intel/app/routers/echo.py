from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.contracts.echo_request import EchoRequest
from app.contracts.echo_response import EchoResponse
from app.security.internal_auth import require_internal_auth

router = APIRouter(prefix="/v1", tags=["echo"], dependencies=[Depends(require_internal_auth)])


def get_clock(request: Request) -> Callable[[], datetime]:
    clock: Callable[[], datetime] = request.app.state.clock
    return clock


@router.post("/echo")
async def echo(
    body: EchoRequest, clock: Annotated[Callable[[], datetime], Depends(get_clock)]
) -> EchoResponse:
    """Signed round trip with generated contract models: proves auth and codegen end to end."""
    return EchoResponse(message=body.message, receivedAt=clock().astimezone(UTC))
