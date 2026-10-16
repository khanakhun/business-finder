import re
from itertools import pairwise

import pytest
from pydantic import ValidationError

from app.settings import Settings, _env_files
from tests.conftest import REPO, SECRET

REQUIRED = {
    "intel_shared_secret": SECRET,
    "s3_endpoint": "http://127.0.0.1:9000",
    "s3_access_key_id": "k",
    "s3_secret_access_key": "s",
}


def intel_variables_in_env_example() -> set[str]:
    """Variables `.env.example` (generated from @bf/config) marks as used by `intel`."""
    names: set[str] = set()
    lines = (REPO / ".env.example").read_text().splitlines()
    for comment, assignment in pairwise(lines):
        apps = re.search(r"\(.*apps: ([^)]*)\)\s*$", comment)
        variable = re.match(r"#?\s*([A-Z][A-Z0-9_]*)=", assignment)
        if apps and variable and "intel" in [a.strip() for a in apps[1].split(",")]:
            names.add(variable[1])
    return names


def test_settings_match_the_declared_environment() -> None:
    """packages/config/src/apps/intel.ts is the source of truth; drift in either direction fails."""
    declared = intel_variables_in_env_example()
    assert declared, ".env.example has no variables for intel"
    assert {name.upper() for name in Settings.model_fields} == declared


def test_defaults_match_the_typescript_schema() -> None:
    settings = Settings(_env_file=None, **REQUIRED)  # type: ignore[arg-type]
    assert settings.intel_port == 8000
    assert settings.intel_workers == 1
    assert settings.intel_fetch_max_bytes == 10_485_760
    assert settings.s3_force_path_style is True
    assert settings.log_level == "info"


def test_reads_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in REQUIRED.items():
        monkeypatch.setenv(name.upper(), value)
    monkeypatch.setenv("INTEL_PORT", "8010")
    monkeypatch.setenv("S3_FORCE_PATH_STYLE", "0")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")  # empty = unset, as in @bf/config
    settings = Settings(_env_file=None)
    assert settings.intel_port == 8010
    assert settings.s3_force_path_style is False
    assert settings.otel_exporter_otlp_endpoint is None


@pytest.mark.parametrize(
    ("override", "field"),
    [
        ({"intel_shared_secret": "too-short"}, "intel_shared_secret"),
        ({"s3_force_path_style": "yes"}, "s3_force_path_style"),  # booleanFlag: only true|false|1|0
        ({"log_level": "verbose"}, "log_level"),
        ({"intel_port": 70_000}, "intel_port"),
    ],
)
def test_rejects_invalid_values(override: dict[str, object], field: str) -> None:
    with pytest.raises(ValidationError, match=field):
        Settings(_env_file=None, **(REQUIRED | override))  # type: ignore[arg-type]


def test_secrets_are_not_printed() -> None:
    settings = Settings(_env_file=None, **REQUIRED)  # type: ignore[arg-type]
    assert SECRET not in repr(settings)


def test_env_files_are_the_monorepo_dotenv_files() -> None:
    assert _env_files() == (REPO / ".env", REPO / ".env.generated")
