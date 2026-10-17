---
id: BF-059
title: Outcome-trained scoring model — dataset builder, training in intel, ONNX scoring, shadow mode, promotion, drift monitoring
milestone: M5 Learn & Scale
epic: scoring
type: feature
priority: P2
size: L
depends_on: [BF-008, BF-031, BF-032, BF-058]
blocks: []
areas: [api, intel, web, ai]
---

# BF-059 — Outcome-trained scoring model: dataset builder, training in intel, ONNX scoring, shadow mode, promotion, drift monitoring

## Context
Rule-based scoring profiles (BF-031) encode the team's intuition. After a few hundred contacts, the real outcomes are known: who replied positively, who claimed a preview, who signed. Those outcomes can tell us which features actually predict success in *this* market ([PRD J7, FR-35](../PRD.md#64-enrichment-audits--scoring)).

BF-031 stores the exact feature snapshot with every score and keeps an append-only score history. BF-058 records outcomes with event-time dimensions and already shows conversion by tier and decile. The Python intel service (BF-008) is the natural home for training ([ADR-0002](../adr/0002-typescript-first-with-python-sidecar.md)). It is stateless and never touches the database, so datasets and artifacts move through object storage with signed URLs. Scoring in production stays in the API via ONNX, so it needs no Python call per score.

## Goal
A reproducible pipeline that:
- builds labelled datasets without leakage;
- trains and calibrates an explainable classifier in intel;
- evaluates it against the rule-based profile;
- registers versioned models with model cards;
- scores in the API via ONNX as a new profile kind;
- runs in **shadow mode** with prospective comparison;
- promotes or rolls back per profile;
- monitors drift and decay.

## Scope
**In scope**
- **Label definition** (versioned, `label_definitions` table + code):
  - Unit: (workspace, business, first contact at time `t0`) for a given offer.
  - **Positive** if any of the following happens within the horizon `H` (default 30 days) after `t0`: triaged reply `interested|question`, site lead captured, or pipeline reaches `engaged` or later.
  - **Negative** if contacted and none of the above within `H`.
  - **Censored** (excluded) if `t0 + H` is in the future.
  - Contacts blocked by compliance or bounced are excluded (not a market signal).
- **Dataset builder** (API, `scoring/ml/`):
  - Features: the **score feature snapshot at `t0`** (from `business_score_history` closest before `t0`) + allowed context features known at decision time (offer, preview built before send, preview quality score, channel, locale, mailbox warm-up stage).
  - **Leakage guard**: an allowlist of features with "known at t0" metadata; anything computed after `t0` (views, replies, later enrichment) is rejected, with tests.
  - Output: Parquet in private storage (`bf-ml/datasets/<id>.parquet`) + manifest (`label_definition_version`, time window, counts, positives, feature list with types, dataset hash).
  - Minimum data gate (configurable): ≥ 300 labelled contacts and ≥ 30 positives per training target; otherwise a clear message with progress ("212/300 contacts, 18/30 positives").
- **Training in intel** (`services/intel/app/ml/`, FastAPI endpoint `POST /ml/train`, HMAC-signed internal auth from BF-008):
  - Inputs: a presigned GET URL for the dataset, presigned PUT URLs for artifacts, and a training config.
  - Models:
    - **Logistic regression** (standardized numeric features, one-hot categoricals, L2; class weights) — the default deployable model, because its explanations are exact (coefficient × standardized value);
    - **HistGradientBoostingClassifier**, considered only if it beats LR by ≥ 0.03 ROC-AUC on the temporal validation set.
  - Splits: **time-based** (train on older contacts, validate on the most recent 25%), plus stratified CV inside the training window for hyperparameters.
  - **Calibration** (isotonic when ≥ 1,000 rows, Platt otherwise) on the validation fold.
  - Metrics:
    - ROC-AUC, PR-AUC, Brier score, a calibration curve (10 bins);
    - lift at the top 10% and 20%;
    - **baseline comparison**: the same metrics for the rule-based score at `t0`, plus Spearman correlation between rankings.
  - Artifacts:
    - **ONNX** model (skl2onnx; verify operator support for the chosen pipeline);
    - preprocessing spec (JSON: feature order, scalers, encodings);
    - the model card (JSON + Markdown: data window, label definition, features, metrics, baseline comparison, warnings such as small sample or class imbalance, intended use);
    - SHA-256 of each artifact.
  - Reproducibility: fixed seeds, library versions in the model card, dataset hash.
  - Optional: `POST /ml/explain` computes TreeSHAP for GBM models on demand (batch) when such a model is deployed.
- **Model registry**: `scoring_models`:
  - `id`, `organization_id`, `offer`, `version`, `kind` (`logreg|hgb`), `status` (`trained|shadow|active|retired|rejected`);
  - `artifact_keys` jsonb, `artifact_hashes`, `model_card` jsonb, `metrics` jsonb, `baseline_metrics` jsonb;
  - `dataset_id`, `label_definition_version`, `trained_by`, `trained_at`, `promoted_by?`, `promoted_at?`.

  Immutable once trained.
- **Scoring with models in the API**:
  - Extend the BF-031 profile config with `kind: 'rules' | 'model'`, `modelId`, `scoreMapping` (calibrated probability → 0–100), and tier thresholds by probability or percentile.
  - `ModelScorer` (onnxruntime-node, models loaded lazily and cached by hash; verify the current package API):
    - computes the probability from the BF-031 feature vector using the preprocessing spec;
    - explanations: LR contributions mapped onto the existing explanation format (waterfall + EN/FR reasons from feature descriptions); GBM via intel `/ml/explain` on demand (cached).
  - Missing features are handled exactly as in training (spec-driven imputation).
- **Shadow mode**:
  - A profile can have a `shadow_model_id`. Scoring runs compute and store shadow scores (`business_scores_shadow`, same shape) without affecting tiers, sorting or automation.
  - **Prospective comparison** (BF-058 scoring-validation extension): for contacts made after shadow start, the realized conversion of the top-k% under the active profile vs under the shadow model; rank correlation; tier movement matrix.
  - **Promotion criteria** (displayed and checked; configurable):
    - ≥ 30 positives in the prospective window;
    - shadow top-20% conversion ≥ 1.2 × active top-20% conversion with a non-overlapping 90% interval, **or** an explicit owner override with a reason.
  - Promotion switches the profile to the model (new profile version) and triggers bulk recompute (BF-031). Rollback restores the previous version.
- **Monitoring**, a monthly job plus on demand:
  - feature drift: PSI per feature, comparing the training distribution to the last 30 days;
  - score distribution shift;
  - decay: rolling ROC-AUC on newly labelled contacts.

  Alerts (notification to owners) when PSI > 0.25 on a top feature or AUC drops by > 0.05. Recommend retraining; never retrain-and-promote automatically.
- **UI** (extends BF-032 Settings → Scoring):
  - "Models" tab: data readiness meter, Train button (owner/admin), training runs with status;
  - model cards (metrics, calibration plot, lift chart vs the rule baseline, feature importance/coefficients with descriptions);
  - shadow toggle, a prospective comparison panel, promote/rollback with criteria checklist, drift panel;
  - business Scores tab shows the shadow score (labelled "shadow") when present.

**Out of scope**
- Deep learning, AutoML, cross-workspace pooled models (privacy and consent questions), causal uplift modelling (possible follow-up), automatic promotion.

## Requirements
### Functional
- No feature computed after `t0` can enter a dataset (allowlist + tests with seeded leakage).
- A model can only become active through promotion with recorded criteria or an override reason; rollback always possible.
- Model scoring matches the intel-side predictions for the same inputs (parity test within 1e-6).
### Non-functional
- Training on 10k rows < 2 minutes in intel; API scoring overhead < 1 ms per business.
- Artifacts verified by hash before loading; models from our own pipeline only (no pickle loading in the API).

## Design
```
apps/api/src/modules/scoring/
├── ml/{label-definition.ts, dataset-builder.ts, leakage-guard.ts, model-registry.ts, model-scorer.ts (onnxruntime),
│       shadow.ts, promotion-policy.ts, drift.ts, intel-client.ts}
├── interface/http/{models.controller.ts}
services/intel/app/ml/{train.py, pipeline.py, calibration.py, evaluate.py, export_onnx.py, model_card.py, explain.py}
services/intel/tests/ml/*
apps/web/src/features/scoring/models/{models-tab.tsx, model-card.tsx, calibration-plot.tsx, lift-chart.tsx,
                                      shadow-panel.tsx, drift-panel.tsx}
```
- Patterns:
  - Pipeline (dataset → train → evaluate → export → register).
  - Strategy (model kinds).
  - Registry with immutable versions.
  - Shadow deployment / champion–challenger.
  - Anti-corruption layer (preprocessing spec shared across Python/TS).

## Implementation plan
1. Label definition + dataset builder + leakage guard (TDD with synthetic histories).
2. Intel training pipeline (LR first), calibration, evaluation vs baseline, ONNX export, model card; pytest with synthetic data where the true signal is known.
3. Registry + artifact storage with hashes; API ModelScorer with a parity test against intel predictions.
4. Profile kind `model` + explanations + shadow scoring.
5. Prospective comparison + promotion/rollback + BF-058 extension.
6. Drift and decay monitoring + alerts; UI; documentation (`docs/scoring/outcome-model.md`).

## Testing
- **Python (pytest + hypothesis):** pipeline trains on synthetic data with a planted signal (AUC > 0.8) and fails gracefully on degenerate data (all negatives); calibration improves the Brier score; ONNX export parity with the sklearn `predict_proba`.
- **TS unit:** leakage guard, label computation edge cases (censoring, multiple contacts, bounced), promotion criteria, PSI computation.
- **Integration:** end to end with intel in Testcontainers or compose: build dataset → train → register → shadow scores computed → promotion blocked without criteria → override with reason → active → rollback.
- **Parity:** TS ONNX scoring equals Python predictions (1e-6) on 1,000 random rows.

## Acceptance criteria
- [x] Versioned label definition and leakage-safe dataset builder with a minimum-data gate.
- [x] Intel training (LR default, optional GBM), temporal validation, calibration, baseline comparison, ONNX export, model cards.
  (GBM is trained as a challenger but cannot be exported with skl2onnx 1.20 + scikit-learn 1.9.)
- [ ] Model registry; ONNX scoring in the API with explanations; parity tests. (Registry, scoring and explanations
  done; parity measured exact by a script on 500 rows, no committed parity test while testing is paused.)
- [x] Shadow mode with prospective comparison; promotion criteria; rollback.
- [x] Drift and decay monitoring with alerts; Models UI.

## Agent prompt
```text
Implement BF-059 (Outcome-trained scoring model).

Read first: AGENTS.md, docs/adr/0002, docs/PRD.md (J7, FR-35), BF-031 (feature registry, snapshots, profiles,
history), BF-032 (scoring UI), BF-058 (facts, scoring validation), BF-008 (intel service conventions, HMAC auth).

Rules:
- Leakage is the main risk: only features known at decision time; prove it with tests.
- Prefer explainable models; promote only on prospective evidence or an explicit, recorded override.
- Intel stays stateless (no DB); data and artifacts via signed URLs; artifacts hashed; no pickle in the API.
- Reproducibility: dataset hash, seeds, versions in the model card.
- Verify current skl2onnx and onnxruntime-node APIs; pin versions.

Verify: pnpm verify && pnpm test:int; (services/intel) uv run task verify; attach the model card of a synthetic run.
```

## References
- ADR-0002 · BF-031 · BF-058
- scikit-learn calibration: https://scikit-learn.org/stable/modules/calibration.html · skl2onnx: https://onnx.ai/sklearn-onnx/ · onnxruntime Node.js: https://onnxruntime.ai/docs/get-started/with-javascript/node.html · Model Cards (Mitchell et al.): https://arxiv.org/abs/1810.03993 · Population Stability Index: https://www.listendata.com/2015/05/population-stability-index.html
