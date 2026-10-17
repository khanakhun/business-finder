import type { FeatureValue, MlCalibration, MlPreprocessingSpec } from '@bf/contracts';

// The TypeScript twin of intel's `app/services/ml/preprocessing.py` (BF-059): a feature vector becomes the model
// input exactly as in training — numbers imputed and standardized (booleans are not numbers), missing
// indicators, booleans as 0/1, one-hot categories with `__other__` for unseen values and `__missing__` for null.
// Calibration and the logistic regression's explanations come from the same spec.

const OTHER = '__other__';
const MISSING = '__missing__';

type Values = Readonly<Record<string, FeatureValue | undefined>>;

const numberOf = (value: FeatureValue | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const isMissing = (value: FeatureValue | undefined) => value === null || value === undefined;

/** The model input for one feature vector (float32, one value per spec column). */
export function inputRow(spec: MlPreprocessingSpec, features: Values): Float32Array {
  const kept = new Map<string, Set<string>>();
  for (const column of spec.columns)
    if (column.kind === 'category' && column.value !== OTHER && column.value !== MISSING) {
      const values = kept.get(column.source) ?? new Set<string>();
      values.add(column.value);
      kept.set(column.source, values);
    }
  const row = new Float32Array(spec.columns.length);
  spec.columns.forEach((column, j) => {
    const value = features[column.source];
    switch (column.kind) {
      case 'numeric':
        row[j] = ((numberOf(value) ?? column.fill) - column.mean) / column.std;
        return;
      case 'missing':
        row[j] = isMissing(value) ? 1 : 0;
        return;
      case 'boolean':
        row[j] = value === true ? 1 : 0;
        return;
      case 'category': {
        if (column.value === MISSING) row[j] = isMissing(value) ? 1 : 0;
        else if (column.value === OTHER)
          row[j] = !isMissing(value) && !kept.get(column.source)?.has(String(value)) ? 1 : 0;
        else row[j] = !isMissing(value) && String(value) === column.value ? 1 : 0;
      }
    }
  });
  return row;
}

const EPSILON = 1e-6;
const logit = (p: number) => {
  const clipped = Math.min(1 - EPSILON, Math.max(EPSILON, p));
  return Math.log(clipped / (1 - clipped));
};

/** The calibrated probability (as intel computed it on validation). */
export function calibrate(calibration: MlCalibration, raw: number): number {
  switch (calibration.method) {
    case 'none':
      return raw;
    case 'platt':
      return 1 / (1 + Math.exp(-(calibration.a * logit(raw) + calibration.b)));
    case 'isotonic': {
      const { x, y } = calibration;
      if (x.length === 0) return raw;
      if (raw <= (x[0] ?? 0)) return y[0] ?? raw;
      if (raw >= (x.at(-1) ?? 1)) return y.at(-1) ?? raw;
      const i = x.findIndex((edge) => edge >= raw);
      const x0 = x[i - 1] ?? 0;
      const x1 = x[i] ?? 1;
      const y0 = y[i - 1] ?? 0;
      const y1 = y[i] ?? 1;
      return x1 === x0 ? y1 : y0 + ((raw - x0) * (y1 - y0)) / (x1 - x0);
    }
  }
}

/**
 * Logistic regression only: each feature's share of the logit (coefficient × column value, summed over the
 * feature's columns). Null for other model kinds.
 */
export function linearContributions(
  spec: MlPreprocessingSpec,
  row: Float32Array,
): Map<string, number> | null {
  if (!spec.linear) return null;
  const contributions = new Map<string, number>();
  spec.columns.forEach((column, j) => {
    const value = (spec.linear?.coefficients[j] ?? 0) * (row[j] ?? 0);
    contributions.set(column.source, (contributions.get(column.source) ?? 0) + value);
  });
  return contributions;
}
