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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
