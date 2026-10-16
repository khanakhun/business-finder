"""Which dataset release to read. Overture deletes releases after ~60 days, so the latest is looked up in its
STAC catalog (cached for a few hours) unless pinned in configuration or by the request."""

import asyncio
import re
import time

import httpx

from app.contracts.problem_details import Code
from app.errors import IntelError

_TTL_SECONDS = 6 * 3600
_RELEASE = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d{1,3}$")


class ReleaseResolver:
    def __init__(self, *, stac_url: str, pinned_overture: str | None, foursquare: str) -> None:
        self._stac_url = stac_url
        self._pinned = pinned_overture
        self._foursquare = foursquare
        self._latest: tuple[str, float] | None = None
        self._lock = asyncio.Lock()

    async def resolve(self, dataset: str, requested: str | None) -> str:
        if requested:
            return requested
        if dataset == "foursquare":
            return self._foursquare
        if self._pinned:
            return self._pinned
        async with self._lock:  # one catalog request when the cache is cold
            if self._latest and time.monotonic() - self._latest[1] < _TTL_SECONDS:
                return self._latest[0]
            latest = await self._fetch_latest()
            self._latest = (latest, time.monotonic())
            return latest

    async def _fetch_latest(self) -> str:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(self._stac_url)
                response.raise_for_status()
                latest = response.json().get("latest")
        except (httpx.HTTPError, ValueError) as error:
            raise IntelError(Code.EXTERNAL_SERVICE_FAILED, "Overture release catalog unavailable.") from error
        # The name ends up in paths and globs: accept the documented shape only.
        if not isinstance(latest, str) or not _RELEASE.fullmatch(latest):
            raise IntelError(Code.EXTERNAL_SERVICE_FAILED, "Overture release catalog has no latest release.")
        return latest
