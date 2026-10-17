"""Feature vectors → model input (BF-059), as the `MlPreprocessingSpec` describes it.

The API scores with the same spec in TypeScript, so every rule here has a twin there
(`apps/api/src/modules/scoring/domain/ml/preprocessing.ts`): numbers are imputed with the training median
then standardized, with a missing indicator when training saw missing values; booleans are 0/1 (missing is 0,
with an indicator); categories are one-hot over the values seen at least `MIN_CATEGORY` times, the rest in
`__other__` and null in `__missing__`. A feature always missing in training is dropped.
"""

from collections import Counter
from collections.abc import Sequence
from statistics import median
from typing import Any

import numpy as np
import numpy.typing as npt

MIN_CATEGORY = 5
OTHER = "__other__"
MISSING = "__missing__"

Column = dict[str, Any]


def numeric_value(value: object) -> float | None:
    """A usable number (booleans and non-finite values are not numbers here)."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if np.isfinite(number) else None


def build_columns(rows: Sequence[dict[str, Any]], features: Sequence[tuple[str, str]]) -> list[Column]:
    """The spec's columns, learned from the training rows (feature id, type) in the dataset's order."""
    columns: list[Column] = []
    for feature_id, feature_type in features:
        values = [row["features"].get(feature_id) for row in rows]
        missing = any(value is None for value in values)
        if feature_type == "numeric":
            numbers = [n for n in (numeric_value(v) for v in values) if n is not None]
            if not numbers:
                continue
            fill = float(median(numbers))
            filled = np.array([n if n is not None else fill for n in (numeric_value(v) for v in values)])
            std = float(filled.std())
            columns.append(
                {
                    "kind": "numeric",
                    "source": feature_id,
                    "fill": fill,
                    "mean": float(filled.mean()),
                    "std": std if std > 1e-12 else 1.0,
                }
            )
            if missing:
                columns.append({"kind": "missing", "source": feature_id})
        elif feature_type == "boolean":
            if all(value is None for value in values):
                continue
            columns.append({"kind": "boolean", "source": feature_id})
            if missing:
                columns.append({"kind": "missing", "source": feature_id})
        else:
            counts = Counter(str(value) for value in values if value is not None)
            kept = sorted(value for value, count in counts.items() if count >= MIN_CATEGORY)
            rare = any(count < MIN_CATEGORY for count in counts.values())
            columns.extend({"kind": "category", "source": feature_id, "value": value} for value in kept)
            if rare:
                columns.append({"kind": "category", "source": feature_id, "value": OTHER})
            if missing and counts:
                columns.append({"kind": "category", "source": feature_id, "value": MISSING})
    return columns


def transform(rows: Sequence[dict[str, Any]], columns: Sequence[Column]) -> npt.NDArray[np.float64]:
    """One row per feature vector, one column per spec column."""
    kept: dict[str, set[str]] = {}
    for column in columns:
        if column["kind"] == "category" and column["value"] not in (OTHER, MISSING):
            kept.setdefault(column["source"], set()).add(column["value"])
    matrix = np.zeros((len(rows), len(columns)), dtype=np.float64)
    for i, row in enumerate(rows):
        features: dict[str, Any] = row["features"]
        for j, column in enumerate(columns):
            value = features.get(column["source"])
            kind = column["kind"]
            if kind == "numeric":
                number = numeric_value(value)
                matrix[i, j] = ((number if number is not None else column["fill"]) - column["mean"]) / column[
                    "std"
                ]
            elif kind == "missing":
                matrix[i, j] = 1.0 if value is None else 0.0
            elif kind == "boolean":
                matrix[i, j] = 1.0 if value is True else 0.0
            else:
                target = column["value"]
                if target == MISSING:
                    matrix[i, j] = 1.0 if value is None else 0.0
                elif target == OTHER:
                    matrix[i, j] = (
                        1.0
                        if value is not None and str(value) not in kept.get(column["source"], set())
                        else 0.0
                    )
                else:
                    matrix[i, j] = 1.0 if value is not None and str(value) == target else 0.0
    return matrix
