"""Open-data search: release → area → (cached) extract → paged, area-filtered rows → `OpenDataPlace`s.

Each query runs on its own DuckDB connection in a worker thread, with a memory limit, a time budget
(`interrupt()` on timeout) and a small concurrency cap, so a heavy area cannot starve the service.
"""

import asyncio
import contextlib
import os
import re
import shutil
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb
import structlog

from app.contracts.open_data_search_request import OpenDataSearchRequest
from app.contracts.problem_details import Code
from app.errors import IntelError
from app.services.open_data import cache, cursor
from app.services.open_data.datasets import DATASETS, DatasetSpec, parquet_source
from app.services.open_data.geometry import Area, area_from_contract
from app.services.open_data.releases import ReleaseResolver
from app.settings import Settings

logger: structlog.stdlib.BoundLogger = structlog.get_logger("bf-intel.open_data")

MAX_CONCURRENT_QUERIES = 2
# How long a request waits for a free query slot before answering 429.
SLOT_WAIT_SECONDS = 30
# Rows scanned per request at most (polygon filtering may skip many): the cursor resumes beyond.
MAX_SCANNED_ROWS = 20_000
_HF_TOKEN = re.compile(r"^[A-Za-z0-9_-]{8,200}$")


@dataclass(frozen=True)
class SearchResult:
    release: str
    places: list[dict[str, object]]
    next_after: str | None
    cached: bool


def _is_remote(path: str) -> bool:
    return path.startswith(("s3://", "hf://", "http://", "https://", "az://"))


def _quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class OpenDataService:
    def __init__(self, settings: Settings, releases: ReleaseResolver) -> None:
        self._settings = settings
        self._releases = releases
        self._cache_dir = Path(settings.open_data_cache_dir)
        self._slots = asyncio.Semaphore(MAX_CONCURRENT_QUERIES)

    async def search(self, request: OpenDataSearchRequest) -> dict[str, object]:
        dataset = request.dataset.value
        spec = DATASETS[dataset]
        token = request.hfToken
        if dataset == "foursquare" and not token:
            raise IntelError(Code.VALIDATION_FAILED, "Foursquare OS Places needs a Hugging Face token.")
        if token and not _HF_TOKEN.fullmatch(token):
            raise IntelError(Code.VALIDATION_FAILED, "The Hugging Face token is malformed.")
        release = await self._releases.resolve(dataset, request.release)
        area = area_from_contract(request.geometry.model_dump(mode="json"))
        after = cursor.decode(request.cursor, dataset, release) if request.cursor else ""
        categories = [c.root for c in request.categories]
        result = await self._run(
            lambda con: self._query(
                con, spec, release, area, categories=categories, after=after, limit=request.limit, token=token
            )
        )
        return {
            "dataset": dataset,
            "release": release,
            "places": result.places,
            "nextCursor": cursor.encode(dataset, release, result.next_after) if result.next_after else None,
            "cached": result.cached,
        }

    async def _run(self, work: Callable[[duckdb.DuckDBPyConnection], SearchResult]) -> SearchResult:
        try:
            await asyncio.wait_for(self._slots.acquire(), timeout=SLOT_WAIT_SECONDS)
        except TimeoutError as error:
            raise IntelError(Code.RATE_LIMITED, "Open-data queries are busy, try again shortly.") from error
        con = duckdb.connect(
            config={
                "memory_limit": self._settings.open_data_memory_limit,
                "threads": 2,
                # Spill files stay in the cache volume and are bounded.
                "temp_directory": str(self._cache_dir / ".duckdb-tmp"),
                "max_temp_directory_size": "2GB",
                **(
                    {"extension_directory": self._settings.open_data_extension_dir}
                    if self._settings.open_data_extension_dir
                    else {}
                ),
            }
        )
        task = asyncio.create_task(asyncio.to_thread(work, con))
        try:
            return await asyncio.wait_for(
                asyncio.shield(task), timeout=self._settings.open_data_query_timeout_seconds
            )
        except TimeoutError as error:
            await self._stop(con, task)
            raise IntelError(Code.EXTERNAL_SERVICE_FAILED, "The open-data query timed out.") from error
        except asyncio.CancelledError:
            # The caller went away: stop the query instead of letting it run on.
            await self._stop(con, task)
            raise
        finally:
            # The slot is released only when the worker thread is really done, so the cap holds.
            def cleanup(_: object = None) -> None:
                with contextlib.suppress(Exception):
                    con.close()
                self._slots.release()

            if task.done():
                cleanup()
            else:
                task.add_done_callback(cleanup)

    @staticmethod
    async def _stop(con: duckdb.DuckDBPyConnection, task: asyncio.Task[SearchResult]) -> None:
        con.interrupt()
        with contextlib.suppress(BaseException):
            await asyncio.wait_for(asyncio.shield(task), timeout=5)

    def _query(
        self,
        con: duckdb.DuckDBPyConnection,
        spec: DatasetSpec,
        release: str,
        area: Area,
        *,
        categories: list[str],
        after: str,
        limit: int,
        token: str | None,
    ) -> SearchResult:
        glob = (
            self._settings.overture_source_url
            if spec.name == "overture"
            else self._settings.foursquare_source_url
        ).format(release=release)
        try:
            self._prepare(con, glob, token)
            source, cached = self._source(con, spec, release, area, glob)
            places, next_after = self._scan(
                con, spec, source, area, categories=categories, after=after, limit=limit
            )
        except duckdb.InterruptException:
            raise
        except duckdb.HTTPException as error:
            status = getattr(error, "status_code", 0)
            logger.warning("open-data source refused", dataset=spec.name, status=status)
            if status in (401, 403):
                raise IntelError(
                    Code.FORBIDDEN, "Dataset access denied: check the token and accepted dataset conditions."
                ) from error
            if status == 404:
                raise IntelError(
                    Code.NOT_FOUND, f"Release {release} of {spec.name} was not found."
                ) from error
            raise IntelError(Code.EXTERNAL_SERVICE_FAILED, "The dataset source failed.") from error
        except duckdb.IOException as error:
            if "No files found" in str(error):
                raise IntelError(
                    Code.NOT_FOUND, f"Release {release} of {spec.name} was not found."
                ) from error
            logger.warning("open-data read failed", dataset=spec.name, error=type(error).__name__)
            raise IntelError(Code.EXTERNAL_SERVICE_FAILED, "The dataset source failed.") from error
        return SearchResult(release, places, next_after, cached)

    def _prepare(self, con: duckdb.DuckDBPyConnection, glob: str, token: str | None) -> None:
        remote = _is_remote(glob) or self._settings.open_data_object_cache
        if remote:
            # Pre-installed in the image; INSTALL is a no-op when present (downloads only in development).
            con.execute("INSTALL httpfs; LOAD httpfs;")
            con.execute("SET s3_region = 'us-west-2'")
        if token and glob.startswith("hf://"):
            # Connection-scoped (temporary) secret; the token is never logged or cached.
            con.execute(f"CREATE SECRET hf_token (TYPE huggingface, TOKEN {_quote(token)})")
        if self._settings.open_data_object_cache:
            s = self._settings
            endpoint = str(s.s3_endpoint)
            con.execute(
                "CREATE SECRET bf_artifacts (TYPE s3, "
                f"KEY_ID {_quote(s.s3_access_key_id.get_secret_value())}, "
                f"SECRET {_quote(s.s3_secret_access_key.get_secret_value())}, "
                f"ENDPOINT {_quote(endpoint.split('://', 1)[-1].rstrip('/'))}, "
                f"USE_SSL {'true' if endpoint.startswith('https') else 'false'}, "
                f"URL_STYLE {_quote('path' if s.s3_force_path_style else 'vhost')}, "
                f"REGION {_quote(s.s3_region)}, SCOPE {_quote('s3://' + s.s3_bucket_artifacts)})"
            )

    def _source(
        self, con: duckdb.DuckDBPyConnection, spec: DatasetSpec, release: str, area: Area, glob: str
    ) -> tuple[str, bool]:
        key = cache.extract_key(spec.name, release, area.bbox)
        if key is None:
            return parquet_source(glob), False
        path = cache.local_path(self._cache_dir, key)
        if path.exists():
            with contextlib.suppress(OSError):
                os.utime(path)  # recently used: kept by the LRU eviction
            return parquet_source(str(path)), True
        object_url = f"s3://{self._settings.s3_bucket_artifacts}/open-data/{key.relative}"
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        if self._settings.open_data_object_cache and self._copy(con, parquet_source(object_url), tmp):
            os.replace(tmp, path)
            return parquet_source(str(path)), True
        b = key.bbox
        extract = spec.extract_sql.format(
            source=parquet_source(glob),
            west=float(b.west),
            south=float(b.south),
            east=float(b.east),
            north=float(b.north),
        )
        try:
            con.execute(f"COPY ({extract}) TO {_quote(str(tmp))} (FORMAT parquet)")
            os.replace(tmp, path)
        except BaseException:
            # Timeouts, interrupts and source errors must not leave partial files behind.
            with contextlib.suppress(OSError):
                tmp.unlink()
            raise
        self._evict(key)
        if self._settings.open_data_object_cache:
            self._copy(con, parquet_source(str(path)), None, target=object_url)
        return parquet_source(str(path)), False

    def _copy(
        self, con: duckdb.DuckDBPyConnection, source: str, local: Path | None, *, target: str | None = None
    ) -> bool:
        """Best effort mirror between the local cache and the artifacts bucket."""
        destination = target or str(local)
        try:
            # Server-built source and destination (cache paths, configured bucket): no user input.
            con.execute(f"COPY (SELECT * FROM {source}) TO {_quote(destination)} (FORMAT parquet)")  # noqa: S608
        except duckdb.InterruptException:
            raise  # the time budget applies to mirroring too
        except duckdb.Error as error:
            logger.info("open-data object cache miss", error=type(error).__name__)
            if local is not None:
                with contextlib.suppress(OSError):
                    local.unlink()
            return False
        return True

    def _evict(self, kept: cache.ExtractKey) -> None:
        """Drops older releases of the dataset, then least recently used extracts beyond the size cap."""
        dataset_dir = self._cache_dir / kept.dataset
        for release_dir in dataset_dir.iterdir() if dataset_dir.is_dir() else ():
            if release_dir.is_dir() and release_dir.name != kept.release:
                shutil.rmtree(release_dir, ignore_errors=True)
        files = sorted(
            (p for p in self._cache_dir.glob("*/*/*.parquet") if p.is_file()), key=lambda p: p.stat().st_mtime
        )
        total = sum(p.stat().st_size for p in files)
        cap = self._settings.open_data_cache_max_mb * 1024 * 1024
        for file in files:
            if total <= cap:
                break
            if file.name == kept.name and file.parent.name == kept.release:
                continue
            total -= file.stat().st_size
            with contextlib.suppress(OSError):
                file.unlink()

    def _scan(
        self,
        con: duckdb.DuckDBPyConnection,
        spec: DatasetSpec,
        source: str,
        area: Area,
        *,
        categories: list[str],
        after: str,
        limit: int,
    ) -> tuple[list[dict[str, object]], str | None]:
        sql = spec.select_sql.format(source=source)
        b = area.bbox
        batch = max(limit, 100) if area.polygons else limit
        places: list[dict[str, object]] = []
        scanned = 0
        while True:
            params: dict[str, Any] = {
                "west": b.west,
                "south": b.south,
                "east": b.east,
                "north": b.north,
                "categories": categories,
                "after": after,
                "limit": batch,
            }
            cur = con.execute(sql, params)
            columns = [d[0] for d in cur.description]
            rows = [dict(zip(columns, values, strict=True)) for values in cur.fetchall()]
            for row in rows:
                after = str(row["id"])
                scanned += 1
                if not area.contains(float(row["lng"]), float(row["lat"])):
                    continue
                place = spec.to_place(row)
                if place is not None:
                    places.append(place)
                if len(places) == limit:
                    return places, after
            if len(rows) < batch:
                return places, None
            if scanned >= MAX_SCANNED_ROWS:
                return places, after
