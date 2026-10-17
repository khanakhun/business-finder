# Outcome-trained scoring (BF-059)

Rule-based profiles (BF-031) encode intuition. Once a workspace has real outcomes, a model can learn which features
actually predict success in its market. This page describes the pipeline end to end.

## 1. Label

A **unit** is the workspace's first contact with a business for an offer (first email for the offer, or first
manual contact), at time `t0`. Label **v1** (`domain/ml/label-definition.ts`, mirrored in `ml_label_definitions`):

| Label | When |
|---|---|
| positive | within 30 days after `t0`: a reply triaged `interested`/`question`, a lead (claim or contact request), or the pipeline reaching `engaged` or later |
| negative | contacted, none of the above, and the 30 days have passed |
| censored | the 30 days are still running and nothing positive happened yet (left out) |
| excluded | the first email hard-bounced (says nothing about the market) |

## 2. Dataset (API)

`POST /v1/scoring/ml/datasets` builds a dataset from the analytics facts (BF-058):

- **Features**: the score snapshot computed at or before `t0` for a profile of the offer (`business_score_history`,
  never recomputed), plus context known at `t0` (`ctx_offer`, `ctx_channel`, `ctx_locale`, `ctx_preview_built`,
  `ctx_preview_quality`).
- **Leakage guard** (`domain/ml/leakage-guard.ts`): only allowlisted features; a snapshot computed after `t0` or a
  preview observed after `t0` fails the build.
- **Gate**: at least 300 labelled contacts and 30 positives (`GET /v1/scoring/ml/readiness` shows the progress).
- **Output**: JSON Lines (gzip) in the artifacts bucket, SHA-256, manifest in `ml_datasets`.

## 3. Training (intel)

`POST /v1/scoring/ml/training-runs` queues a run (`scoring-ml-train`, one at a time). The worker gives intel a
presigned GET of the dataset and presigned PUTs for the artifacts; intel (`app/services/ml/pipeline.py`):

1. checks the dataset's SHA-256 and that every URL is on the configured object store;
2. splits by time (the most recent 25% validate);
3. fits a logistic regression (balanced classes, C by stratified CV in the training window);
4. tries gradient boosting, used only when ≥ 0.03 ROC-AUC better **and** exportable to ONNX;
5. calibrates (Platt below 1,000 rows, isotonic above);
6. reports ROC-AUC, PR-AUC, Brier, calibration bins and lift at 10%/20%, for the model and for the rule score at
   `t0`, plus their rank correlation;
7. exports ONNX and checks it against scikit-learn; writes the preprocessing spec and the model card.

The API registers an **immutable** model version (`scoring_models`; a trigger refuses changes other than status
and promotion).

## 4. Scoring with a model (API)

`onnxruntime-node` runs the model; the artifacts are checked against their recorded SHA-256 before loading. The
preprocessing spec (`MlPreprocessingSpec` in `@bf/contracts`) is applied identically in Python and TypeScript
(`domain/ml/preprocessing.ts`); a parity check on 500 rows measured no difference.

A profile with `kind: 'model'` scores 100 × calibrated probability, with tiers by probability, through the profile's
gates. Logistic regression explains exactly: a feature's points are its share of the logit × p·(1−p) × 100. If the
model cannot be loaded, the rules score stands (logged).

## 5. Shadow, comparison, promotion

- **Shadow** (`PUT /v1/scoring/ml/shadow`): the model scores every business beside a profile, stored apart
  (`business_score_shadows`), changing no tier, sort or automation.
- **Prospective comparison** (`GET /v1/scoring/ml/profiles/:id/comparison`): contacts made since the shadow started,
  ranked by what each side said at the contact. Criteria: ≥ 30 positives, the shadow's top 20% converting ≥ 1.2× the
  active top 20%, non-overlapping 90% Wilson intervals.
- **Promotion** (`POST /v1/scoring/ml/promotions`): only on the criteria, or with an owner's override reason
  (recorded and audited). A new profile version (`kind: 'model'`, rules kept) is activated and the workspace
  recomputes. **Rollback** (`POST /v1/scoring/ml/rollbacks`) reactivates the replaced version.

## 6. Monitoring

Monthly for active and shadow models (and on demand): feature PSI (training vs the last 30 days), score PSI, and
ROC-AUC on contacts labelled since training. A PSI over 0.25 on a top feature or an AUC drop over 0.05 notifies the
owners (`scoring_drift`). Retraining is recommended, never automatic; nothing is ever promoted automatically.

## Known limits

- Gradient boosting cannot be exported with skl2onnx 1.20 and scikit-learn 1.9: logistic regression is deployed.
- Live scores assume the decision ahead: a first email for the offer, no preview yet, unknown language.
- Backfilled facts carry today's dimensions (BF-058); the mailbox warm-up stage is not a feature.
