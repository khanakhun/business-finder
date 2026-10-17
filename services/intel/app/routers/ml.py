"""POST /v1/ml/train (BF-059): trains an outcome model for the API, statelessly.

The API sends presigned URLs: one GET for the dataset (its SHA-256 is checked before use) and one PUT
per artifact. Only URLs on the configured object store are followed: intel fetches nothing else here.
The training runs in the CPU pool; the response carries the metrics, the model card and each artifact's
SHA-256 for the API's registry (which re-checks them before loading a model).
"""

import hashlib
import json
from typing import Annotated, Any
from urllib.parse import urlsplit

import httpx
import structlog
from fastapi import APIRouter, Depends, Request

from app.concurrency import CpuPool
from app.contracts.ml_train_request import MlTrainRequest
from app.contracts.ml_train_result import MlTrainResult
from app.contracts.problem_details import Code
from app.errors import IntelError
from app.security.internal_auth import require_internal_auth
from app.services.ml.pipeline import TrainingError, TrainOutput, load_rows, train
from app.settings import Settings

router = APIRouter(prefix="/v1/ml", tags=["ml"], dependencies=[Depends(require_internal_auth)])
logger: structlog.stdlib.BoundLogger = structlog.get_logger("bf-intel.ml")

MAX_DATASET_BYTES = 200 * 1024 * 1024
TIMEOUT = httpx.Timeout(60.0)


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_cpu_pool(request: Request) -> CpuPool:
    pool: CpuPool = request.app.state.cpu_pool
    return pool


def _origin(url: str) -> tuple[str, str]:
    parts = urlsplit(url)
    return parts.scheme, parts.netloc


def _check_storage_url(url: str, settings: Settings) -> None:
    if _origin(url) != _origin(str(settings.s3_endpoint)):
        raise IntelError(Code.VALIDATION_FAILED, "Dataset and artifact URLs must point to the object store.")


async def _download(client: httpx.AsyncClient, url: str, sha256: str) -> bytes:
    response = await client.get(url)
    if response.status_code != 200:
        raise IntelError(
            Code.EXTERNAL_SERVICE_FAILED, f"The dataset could not be read ({response.status_code})."
        )
    data = response.content
    if len(data) > MAX_DATASET_BYTES:
        raise IntelError(Code.VALIDATION_FAILED, "The dataset is too large.")
    if hashlib.sha256(data).hexdigest() != sha256:
        raise IntelError(Code.VALIDATION_FAILED, "The dataset does not match its SHA-256.")
    return data


async def _upload(client: httpx.AsyncClient, url: str, body: bytes, content_type: str) -> str:
    response = await client.put(url, content=body, headers={"Content-Type": content_type})
    if response.status_code not in (200, 204):
        raise IntelError(
            Code.EXTERNAL_SERVICE_FAILED, f"An artifact could not be stored ({response.status_code})."
        )
    return hashlib.sha256(body).hexdigest()


@router.post("/train")
async def train_model(
    body: MlTrainRequest,
    settings: Annotated[Settings, Depends(get_settings)],
    pool: Annotated[CpuPool, Depends(get_cpu_pool)],
) -> MlTrainResult:
    """Downloads the dataset, trains and evaluates a model, uploads its artifacts, and reports."""
    urls = body.artifactUrls
    for url in (body.datasetUrl, urls.model, urls.preprocessing, urls.modelCardJson, urls.modelCardMd):
        _check_storage_url(str(url), settings)
    config: dict[str, Any] = body.model_dump(mode="json", exclude={"datasetUrl", "artifactUrls"})
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False) as client:
        rows = load_rows(await _download(client, str(body.datasetUrl), body.datasetSha256))
        try:
            output: TrainOutput = await pool.run_cpu_bound(train, rows, config)
        except TrainingError as error:
            raise IntelError(Code.VALIDATION_FAILED, str(error)) from error
        hashes = {
            "model": await _upload(client, str(urls.model), output.onnx, "application/octet-stream"),
            "preprocessing": await _upload(
                client, str(urls.preprocessing), json.dumps(output.spec).encode(), "application/json"
            ),
            "modelCardJson": await _upload(
                client, str(urls.modelCardJson), json.dumps(output.card).encode(), "application/json"
            ),
            "modelCardMd": await _upload(
                client, str(urls.modelCardMd), output.card_md.encode(), "text/markdown; charset=utf-8"
            ),
        }
    logger.info("model trained", dataset=body.datasetId, kind=output.kind, rows=output.train_rows)
    return MlTrainResult.model_validate(
        {
            "kind": output.kind,
            "metrics": output.metrics,
            "baselineMetrics": output.baseline_metrics,
            "spearman": output.spearman,
            "trainRows": output.train_rows,
            "validationRows": output.validation_rows,
            "artifactHashes": hashes,
            "modelCard": output.card,
            "warnings": output.warnings,
        }
    )
