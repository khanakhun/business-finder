"""Model evaluation (BF-059): discrimination, calibration, lift and the comparison with the rule score."""

from typing import Any

import numpy as np
import numpy.typing as npt
from scipy.stats import spearmanr
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

FloatArray = npt.NDArray[np.float64]


def _lift(y: FloatArray, p: FloatArray, share: float) -> float | None:
    base = float(y.mean()) if len(y) else 0.0
    if base == 0.0:
        return None
    k = max(1, int(np.ceil(len(p) * share)))
    top = np.argsort(-p, kind="stable")[:k]
    return float(y[top].mean() / base)


def calibration_bins(y: FloatArray, p: FloatArray, bins: int = 10) -> list[dict[str, Any]]:
    """Mean predicted vs observed rate per equal-width bin of the prediction (non-empty bins only)."""
    out: list[dict[str, Any]] = []
    edges = np.linspace(0.0, 1.0, bins + 1)
    index = np.clip(np.digitize(p, edges[1:-1], right=True), 0, bins - 1)
    for b in range(bins):
        mask = index == b
        if mask.any():
            out.append(
                {"predicted": float(p[mask].mean()), "observed": float(y[mask].mean()), "n": int(mask.sum())}
            )
    return out


def metrics(y: FloatArray, p: FloatArray) -> dict[str, Any]:
    both = len(np.unique(y)) == 2
    return {
        "rocAuc": float(roc_auc_score(y, p)) if both else None,
        "prAuc": float(average_precision_score(y, p)) if both else None,
        "brier": float(brier_score_loss(y, np.clip(p, 0.0, 1.0))) if len(y) else None,
        "liftTop10": _lift(y, p, 0.1),
        "liftTop20": _lift(y, p, 0.2),
        "calibration": calibration_bins(y, np.clip(p, 0.0, 1.0)),
    }


def spearman(a: FloatArray, b: FloatArray) -> float | None:
    if len(a) < 3 or np.ptp(a) == 0 or np.ptp(b) == 0:
        return None
    value = float(spearmanr(a, b).statistic)
    return value if np.isfinite(value) else None
