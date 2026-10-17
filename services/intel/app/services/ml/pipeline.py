"""The training pipeline (BF-059): dataset → preprocessing spec → model → calibration → evaluation → ONNX.

Runs in the CPU pool (module-level function, plain data in and out). Rows are split by time — the most recent
share validates — so the model is judged on contacts it could not have seen. Logistic regression is the
default (explanations are exact); a gradient-boosted model is tried and used only when it beats it by
`gbmMinAucGain` on validation and exports to ONNX. Probabilities are calibrated on the validation rows
(isotonic from 1,000 rows, Platt below). The ONNX graph is checked against scikit-learn before it is returned.
"""

import gzip
import json
import math
import platform
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import numpy.typing as npt
import onnxruntime as ort
import skl2onnx
import sklearn
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GridSearchCV, StratifiedKFold

from app.services.ml.evaluate import metrics, spearman
from app.services.ml.preprocessing import build_columns, transform

FloatArray = npt.NDArray[np.float64]
INPUT_NAME = "input"
OUTPUT_NAME = "probabilities"
PARITY_TOLERANCE = 1e-4
EPSILON = 1e-6
MIN_ROWS = 20
LARGE_SAMPLE = 1000
IMBALANCE = 0.05
INTENDED_USE = (
    "Ranks this workspace's businesses by the chance of a positive outcome within the horizon after a first "
    "contact for this offer. Not for other offers, other workspaces or other markets; retrain when drift "
    "is reported."
)


class TrainingError(ValueError):
    """The data cannot train a model (one class only, too few rows): a 422 with this message."""


@dataclass
class TrainOutput:
    kind: str
    onnx: bytes
    spec: dict[str, Any]
    card: dict[str, Any]
    card_md: str
    metrics: dict[str, Any]
    baseline_metrics: dict[str, Any]
    spearman: float | None
    train_rows: int
    validation_rows: int
    warnings: list[str] = field(default_factory=list)


def load_rows(data: bytes) -> list[dict[str, Any]]:
    """The dataset's rows (JSON Lines, gzip), oldest first."""
    rows = [json.loads(line) for line in gzip.decompress(data).decode("utf-8").splitlines() if line.strip()]
    rows.sort(key=lambda row: str(row["t0"]))
    return rows


def _logit(p: FloatArray) -> FloatArray:
    clipped = np.clip(p, EPSILON, 1 - EPSILON)
    return np.asarray(np.log(clipped / (1 - clipped)), dtype=np.float64)


def _calibrate(raw: FloatArray, y: FloatArray) -> tuple[dict[str, Any], FloatArray]:
    if len(np.unique(y)) < 2:
        return {"method": "none"}, raw
    if len(y) >= 1000:
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(raw, y)
        x = [float(v) for v in iso.X_thresholds_]
        values = [float(v) for v in iso.y_thresholds_]
        return {"method": "isotonic", "x": x, "y": values}, np.interp(raw, x, values)
    platt = LogisticRegression(C=1e6, max_iter=1000).fit(_logit(raw).reshape(-1, 1), y)
    a, b = float(platt.coef_[0][0]), float(platt.intercept_[0])
    return {"method": "platt", "a": a, "b": b}, 1 / (1 + np.exp(-(a * _logit(raw) + b)))


def _export(model: Any, columns: int) -> bytes:  # noqa: ANN401 — scikit-learn estimators are untyped
    onx = convert_sklearn(
        model,
        initial_types=[(INPUT_NAME, FloatTensorType([None, columns]))],
        options={id(model): {"zipmap": False}},
    )
    return bytes(onx.SerializeToString())


def _onnx_probabilities(onnx: bytes, x: FloatArray) -> FloatArray:
    session = ort.InferenceSession(onnx, providers=["CPUExecutionProvider"])
    output = session.run([OUTPUT_NAME], {INPUT_NAME: x.astype(np.float32)})[0]
    return np.asarray(output, dtype=np.float64)[:, 1]


def _markdown(card: dict[str, Any]) -> str:
    def fmt(value: object) -> str:
        return f"{value:.3f}" if isinstance(value, float) else "—" if value is None else str(value)

    m, b = card["metrics"], card["baselineMetrics"]
    lines = [
        f"# Model card — {card['model']['kind']} for {card['data']['offer']}",
        "",
        f"Trained on {card['data']['trainRows']} first contacts, validated on the "
        f"{card['data']['validationRows']} most recent (label v{card['data']['labelVersion']}, "
        f"{card['data']['horizonDays']}-day horizon).",
        "",
        "| Metric | Model | Rule score |",
        "|---|---|---|",
        *(
            f"| {name} | {fmt(m[key])} | {fmt(b[key])} |"
            for name, key in (
                ("ROC-AUC", "rocAuc"),
                ("PR-AUC", "prAuc"),
                ("Brier", "brier"),
                ("Lift top 10%", "liftTop10"),
                ("Lift top 20%", "liftTop20"),
            )
        ),
        "",
        f"Rank correlation with the rule score: {fmt(card['spearman'])}. Calibration: {card['calibration']}.",
        "",
        "## Warnings",
        *([f"- {w}" for w in card["warnings"]] or ["- none"]),
        "",
        "## Intended use",
        card["intendedUse"],
        "",
        f"Dataset {card['data']['datasetId']} (sha256 {card['data']['datasetSha256']}); "
        f"seed {card['model']['seed']}; scikit-learn {card['model']['libraries']['scikit-learn']}, "
        f"skl2onnx {card['model']['libraries']['skl2onnx']}.",
    ]
    return "\n".join(lines) + "\n"


def _split(
    rows: list[dict[str, Any]], config: dict[str, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], FloatArray, FloatArray]:
    """The older contacts train, the most recent `validationShare` validate."""
    if len(rows) < MIN_ROWS:
        raise TrainingError(f"Only {len(rows)} labelled contacts: too few to train.")
    y_all = np.array([float(row["label"]) for row in rows])
    if len(np.unique(y_all)) < 2:
        raise TrainingError("Every contact has the same outcome: nothing to learn from.")
    n_val = max(1, math.ceil(len(rows) * float(config.get("validationShare", 0.25))))
    if len(np.unique(y_all[:-n_val])) < 2:
        raise TrainingError("The older contacts have a single outcome: wait for more history.")
    return rows[:-n_val], rows[-n_val:], y_all[:-n_val], y_all[-n_val:]


def _fit_logreg(x: FloatArray, y: FloatArray, seed: int) -> tuple[Any, dict[str, Any]]:
    """L2 logistic regression with balanced classes; C by stratified CV inside the training window."""
    folds = int(min(5, y.sum(), len(y) - y.sum()))
    lr = LogisticRegression(max_iter=2000, class_weight="balanced")
    if folds < 2:
        return lr.fit(x, y), {"C": 1.0}
    search = GridSearchCV(
        lr,
        {"C": [0.01, 0.1, 1.0, 10.0]},
        scoring="roc_auc",
        cv=StratifiedKFold(n_splits=folds, shuffle=True, random_state=seed),
    )
    search.fit(x, y)
    return search.best_estimator_, {"C": float(search.best_params_["C"])}


def _challenge(
    lr: Any,  # noqa: ANN401 — scikit-learn estimators are untyped
    data: tuple[FloatArray, FloatArray, FloatArray, FloatArray],
    config: dict[str, Any],
    warnings: list[str],
) -> tuple[str, Any]:
    """Gradient boosting replaces the logistic regression only when clearly better and exportable."""
    x_train, y_train, x_val, y_val = data
    if not config.get("considerGbm", True) or len(np.unique(y_val)) < 2:
        return "logreg", lr
    lr_auc = float(roc_auc_score(y_val, lr.predict_proba(x_val)[:, 1]))
    gbm = HistGradientBoostingClassifier(
        random_state=int(config.get("seed", 42)), max_iter=200, learning_rate=0.05, class_weight="balanced"
    )
    gbm.fit(x_train, y_train)
    gbm_auc = float(roc_auc_score(y_val, gbm.predict_proba(x_val)[:, 1]))
    if gbm_auc < lr_auc + float(config.get("gbmMinAucGain", 0.03)):
        return "logreg", lr
    try:
        _export(gbm, x_train.shape[1])
    except Exception as error:
        warnings.append(
            f"Gradient boosting beat logistic regression (ROC-AUC {gbm_auc:.3f} vs {lr_auc:.3f}) but "
            f"cannot be exported to ONNX ({type(error).__name__}); logistic regression is kept."
        )
        return "logreg", lr
    return "hgb", gbm


def _warnings(
    rows: list[dict[str, Any]], has_base: npt.NDArray[np.bool_], model: dict[str, Any], base: dict[str, Any]
) -> list[str]:
    warnings: list[str] = []
    positives = sum(int(row["label"]) for row in rows)
    if len(rows) < LARGE_SAMPLE:
        warnings.append(f"Small sample: {len(rows)} contacts; expect wide uncertainty.")
    if positives / len(rows) < IMBALANCE:
        warnings.append(f"Imbalanced classes: {positives} positives ({positives / len(rows):.1%}).")
    if not has_base.all():
        warnings.append(f"{int((~has_base).sum())} validation contacts had no rule score at contact time.")
    if model["rocAuc"] is not None and base["rocAuc"] is not None and model["rocAuc"] <= base["rocAuc"]:
        warnings.append("The model does not rank better than the rule score on validation.")
    return warnings


def train(rows: list[dict[str, Any]], config: dict[str, Any]) -> TrainOutput:
    """Trains, calibrates, evaluates and exports a model for one dataset (config: the request's fields)."""
    seed = int(config.get("seed", 42))
    train_rows, val_rows, y_train, y_val = _split(rows, config)
    features = [(f["id"], f["type"]) for f in config["features"]]
    columns = build_columns(train_rows, features)
    if not columns:
        raise TrainingError("No feature has any value in the training rows.")
    x_train, x_val = transform(train_rows, columns), transform(val_rows, columns)
    lr, hyper = _fit_logreg(x_train, y_train, seed)
    challenger_warnings: list[str] = []
    kind, model = _challenge(lr, (x_train, y_train, x_val, y_val), config, challenger_warnings)

    onnx = _export(model, len(columns))
    raw_val = np.asarray(model.predict_proba(x_val)[:, 1], dtype=np.float64)
    parity = float(np.abs(_onnx_probabilities(onnx, x_val) - raw_val).max())
    if parity > PARITY_TOLERANCE:
        raise TrainingError(f"The ONNX model differs from scikit-learn by {parity:.2e}.")
    calibration, p_val = _calibrate(raw_val, y_val)

    model_metrics = metrics(y_val, p_val)
    has_base = np.array([row.get("baseline_score") is not None for row in val_rows])
    base_scores = np.array([float(row.get("baseline_score") or 0) / 100 for row in val_rows])
    baseline = metrics(y_val[has_base], base_scores[has_base])
    rank = spearman(p_val[has_base], base_scores[has_base])
    warnings = [*challenger_warnings, *_warnings(rows, has_base, model_metrics, baseline)]

    linear = (
        {"intercept": float(model.intercept_[0]), "coefficients": [float(c) for c in model.coef_[0]]}
        if kind == "logreg"
        else None
    )
    spec = {
        "version": 1,
        "kind": kind,
        "columns": columns,
        "onnx": {"inputName": INPUT_NAME, "outputName": OUTPUT_NAME, "positiveIndex": 1},
        "calibration": calibration,
        "linear": linear,
    }
    card: dict[str, Any] = {
        "model": {
            "kind": kind,
            "hyperparameters": hyper,
            "seed": seed,
            "onnxParity": parity,
            "libraries": {
                "python": platform.python_version(),
                "scikit-learn": sklearn.__version__,
                "skl2onnx": skl2onnx.__version__,
                "onnxruntime": ort.__version__,
                "numpy": np.__version__,
            },
        },
        "data": {
            "datasetId": config["datasetId"],
            "datasetSha256": config["datasetSha256"],
            "offer": config["offer"],
            "labelVersion": config["labelVersion"],
            "horizonDays": config["horizonDays"],
            "trainRows": len(train_rows),
            "validationRows": len(val_rows),
            "positivesTrain": int(y_train.sum()),
            "positivesValidation": int(y_val.sum()),
            "trainWindow": [train_rows[0]["t0"], train_rows[-1]["t0"]],
            "validationWindow": [val_rows[0]["t0"], val_rows[-1]["t0"]],
        },
        "features": [{"id": f[0], "type": f[1]} for f in features],
        "columns": len(columns),
        "metrics": model_metrics,
        "baselineMetrics": baseline,
        "spearman": rank,
        "calibration": calibration["method"],
        "warnings": warnings,
        "intendedUse": INTENDED_USE,
    }
    return TrainOutput(
        kind=kind,
        onnx=onnx,
        spec=spec,
        card=card,
        card_md=_markdown(card),
        metrics=model_metrics,
        baseline_metrics=baseline,
        spearman=rank,
        train_rows=len(train_rows),
        validation_rows=len(val_rows),
        warnings=warnings,
    )
