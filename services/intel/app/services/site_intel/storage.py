"""Artifact storage for screenshots and page markdown (the artifacts bucket, under the caller's prefix)."""

import asyncio
from typing import TYPE_CHECKING, Protocol

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.settings import Settings

if TYPE_CHECKING:
    # Stubs are a dev dependency: types only, never imported at run time.
    from mypy_boto3_s3 import S3Client


class ArtifactStoreError(Exception):
    """An artifact could not be stored (the analysis goes on without it)."""


class ArtifactStore(Protocol):
    async def put(self, key: str, data: bytes, content_type: str) -> None: ...


class S3ArtifactStore:
    """boto3 in a worker thread (its client is thread-safe); one client per process."""

    def __init__(self, settings: Settings) -> None:
        self._bucket = settings.s3_bucket_artifacts
        self._client: S3Client = boto3.client(
            "s3",
            endpoint_url=str(settings.s3_endpoint),
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key_id.get_secret_value(),
            aws_secret_access_key=settings.s3_secret_access_key.get_secret_value(),
            config=Config(
                s3={"addressing_style": "path" if settings.s3_force_path_style else "auto"},
                retries={"max_attempts": 3, "mode": "standard"},
                connect_timeout=5,
                read_timeout=30,
            ),
        )

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        try:
            await asyncio.to_thread(
                self._client.put_object, Bucket=self._bucket, Key=key, Body=data, ContentType=content_type
            )
        except (BotoCoreError, ClientError) as error:
            raise ArtifactStoreError(type(error).__name__) from error


class MemoryArtifactStore:
    """Tests: keeps what was stored."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        self.objects[key] = (data, content_type)
