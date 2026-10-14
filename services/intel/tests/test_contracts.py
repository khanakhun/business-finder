import json
import subprocess
import sys
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.contracts.echo_request import EchoRequest
from app.contracts.echo_response import EchoResponse
from app.contracts.error_codes import ERROR_CODES, ERROR_TYPE_BASE
from app.contracts.lat_lng import LatLng
from app.contracts.problem_details import Code, ProblemDetails
from tests.conftest import REPO

INTEL = REPO / "services/intel"


def test_generated_models_validate_sample_payloads() -> None:
    assert EchoRequest.model_validate({"message": "hello"}).message == "hello"
    response = EchoResponse.model_validate({"message": "hi", "receivedAt": "2026-10-15T00:00:00Z"})
    assert response.receivedAt == datetime(2026, 10, 15, tzinfo=UTC)
    assert LatLng.model_validate({"lat": 17.9, "lng": -62.85}).lat == 17.9
    problem = ProblemDetails.model_validate(
        {"type": f"{ERROR_TYPE_BASE}NOT_FOUND", "title": "Not found", "status": 404, "code": "NOT_FOUND"}
    )
    assert problem.code is Code.NOT_FOUND


@pytest.mark.parametrize(
    "payload",
    [{"message": ""}, {"message": "x" * 2001}, {"message": "ok", "extra": 1}, {}],
)
def test_generated_models_keep_the_zod_constraints(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        EchoRequest.model_validate(payload)


def test_error_registry_matches_the_typescript_export() -> None:
    exported = json.loads((REPO / "packages/contracts/generated/error-codes.json").read_text())
    assert exported["typeBase"] == ERROR_TYPE_BASE
    assert {code.value: [info.status, info.title] for code, info in ERROR_CODES.items()} == {
        code: [info["status"], info["title"]] for code, info in exported["codes"].items()
    }
    assert set(ERROR_CODES) == set(Code)


def test_committed_models_are_up_to_date() -> None:
    """Same check CI runs: regenerating from the committed JSON Schemas changes nothing."""
    result = subprocess.run(
        [sys.executable, "scripts/gen_contracts.py", "--check"],
        cwd=INTEL,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
