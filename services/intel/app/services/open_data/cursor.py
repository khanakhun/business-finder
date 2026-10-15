"""Opaque keyset cursors: results are ordered by dataset id, a cursor resumes after the last id scanned."""

import base64
import json

from app.contracts.problem_details import Code
from app.errors import IntelError


def encode(dataset: str, release: str, after_id: str) -> str:
    raw = json.dumps({"d": dataset, "r": release, "a": after_id}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode(cursor: str, dataset: str, release: str) -> str:
    """The id to resume after; a cursor from another dataset or release is refused (results would shift)."""
    invalid = IntelError(Code.VALIDATION_FAILED, "The cursor is invalid for this search.")
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded))
    except ValueError as error:
        raise invalid from error
    after = data.get("a") if isinstance(data, dict) else None
    if (
        not isinstance(data, dict)
        or data.get("d") != dataset
        or data.get("r") != release
        or not isinstance(after, str)
    ):
        raise invalid
    return after
