"""Configuration (pydantic-settings). The only module that reads the environment (coding-standards.md §4).

Every variable is declared in `@bf/config` (`packages/config/src/apps/intel.ts`); `tests/test_settings.py`
fails if this model and the generated `.env.example` disagree.
"""

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import AnyHttpUrl, BeforeValidator, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

type LogLevel = Literal["trace", "debug", "info", "warn", "error", "fatal"]

_FLAGS = {"true": True, "1": True, "false": False, "0": False}


def _strict_flag(value: object) -> object:
    """Same rule as `booleanFlag` in @bf/config: only true|false|1|0 (no "yes", no empty string)."""
    if isinstance(value, str):
        if value not in _FLAGS:
            raise ValueError("expected one of true, false, 1, 0")
        return _FLAGS[value]
    return value


type Flag = Annotated[bool, BeforeValidator(_strict_flag)]


def _env_files() -> tuple[Path, ...]:
    """`.env` then `.env.generated` at the monorepo root (later files win; real env vars beat both)."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "pnpm-workspace.yaml").is_file():
            return (parent / ".env", parent / ".env.generated")
    return ()  # Container image: configuration comes from the environment only.


class Settings(BaseSettings):
    # Empty values count as unset, as in @bf/config (`KEY=` in .env, `${VAR:-}` in compose).
    model_config = SettingsConfigDict(
        env_file=_env_files(), env_ignore_empty=True, extra="ignore", frozen=True
    )

    node_env: Literal["development", "test", "production"] = "development"
    log_level: LogLevel = "info"
    app_version: Annotated[str, Field(min_length=1)] = "0.0.0-dev"
    otel_exporter_otlp_endpoint: AnyHttpUrl | None = None

    intel_shared_secret: Annotated[SecretStr, Field(min_length=32)]

    s3_endpoint: AnyHttpUrl
    s3_region: Annotated[str, Field(min_length=1)] = "us-east-1"
    s3_access_key_id: Annotated[SecretStr, Field(min_length=1)]
    s3_secret_access_key: Annotated[SecretStr, Field(min_length=1)]
    s3_force_path_style: Flag = True
    s3_bucket_assets: Annotated[str, Field(min_length=3)] = "bf-assets"
    s3_bucket_artifacts: Annotated[str, Field(min_length=3)] = "bf-artifacts"
    s3_bucket_sites: Annotated[str, Field(min_length=3)] = "bf-sites"

    intel_host: Annotated[str, Field(min_length=1)] = "127.0.0.1"
    intel_port: Annotated[int, Field(ge=1, le=65_535)] = 8000
    intel_workers: Annotated[int, Field(ge=1, le=32)] = 1
    intel_cpu_workers: Annotated[int, Field(ge=1, le=64)] | None = None
    intel_max_request_bytes: Annotated[int, Field(gt=0)] = 1_048_576
    intel_fetch_timeout_seconds: Annotated[float, Field(gt=0, le=300)] = 20.0
    intel_fetch_max_bytes: Annotated[int, Field(gt=0)] = 10_485_760

    # Website intelligence (BF-026).
    site_intel_user_agent: Annotated[str, Field(min_length=8, max_length=200)] = (
        "BusinessFinderBot/1.0 (+https://github.com/khanakhun/business-finder/blob/main/docs/bot.md)"
    )
    site_intel_max_contexts: Annotated[int, Field(ge=1, le=16)] = 2
    site_intel_resource_max_bytes: Annotated[int, Field(gt=0, le=52_428_800)] = 5_242_880
    site_intel_resource_timeout_seconds: Annotated[float, Field(gt=0, le=60)] = 15.0
    site_intel_chromium_sandbox: Flag = True
    site_intel_browser_check: Flag = True

    # Open data (BF-019): DuckDB over Overture / Foursquare parquet, with regional extracts cached.
    open_data_cache_dir: Annotated[str, Field(min_length=1)] = ".cache/open-data"
    open_data_object_cache: Flag = False
    open_data_extension_dir: Annotated[str, Field(min_length=1)] | None = None
    open_data_cache_max_mb: Annotated[int, Field(ge=100, le=1_000_000)] = 5_120
    open_data_query_timeout_seconds: Annotated[float, Field(gt=0, le=600)] = 120.0
    open_data_memory_limit: Annotated[str, Field(pattern=r"^\d+(MB|GB)$")] = "1GB"
    overture_release: Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}\.\d{1,3}$")] | None = None
    overture_stac_url: AnyHttpUrl = AnyHttpUrl("https://stac.overturemaps.org/catalog.json")
    overture_source_url: Annotated[str, Field(min_length=1)] = (
        "s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*.parquet"
    )
    foursquare_release: Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")] = "2026-09-15"
    foursquare_source_url: Annotated[str, Field(min_length=1)] = (
        "hf://datasets/foursquare/fsq-os-places/release/dt={release}/places/parquet/*.parquet"
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
