import {
  FEATURE_DEFINITIONS,
  type FeatureKey,
  type Gate,
  type GateCondition,
  GateConditionSchema,
} from '@bf/contracts';

// The gates builder's model (BF-032): a gate is "all" or "any" of simple rules (feature, operator, value), turned into
// the gate DSL the engine reads. A condition the builder cannot show (nested groups, `not`) stays as it is and is
// shown read-only; it is kept untouched on save.

export const OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'isNull'] as const;
export type Operator = (typeof OPERATORS)[number];

export interface Rule {
  readonly feature: FeatureKey;
  readonly op: Operator;
  /** As typed: parsed for the feature's type (a comma-separated list for `in`). */
  readonly value: string;
}

export type GateDraft = Omit<Gate, 'when'> &
  (
    | { readonly mode: 'rules'; readonly match: 'all' | 'any'; readonly rules: readonly Rule[] }
    | { readonly mode: 'advanced'; readonly when: GateCondition }
  );

/** Operators that make sense for a feature's type. */
export function operatorsFor(feature: FeatureKey): readonly Operator[] {
  const { type, missingDefault } = FEATURE_DEFINITIONS[feature];
  const base: Operator[] =
    type === 'number'
      ? ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']
      : type === 'enum'
        ? ['eq', 'neq', 'in']
        : ['eq', 'neq'];
  // A feature with a default is never missing.
  return missingDefault === undefined ? [...base, 'isNull'] : base;
}

type Scalar = number | boolean | string;

function scalar(feature: FeatureKey, text: string): Scalar | null {
  const { type, values } = FEATURE_DEFINITIONS[feature];
  const trimmed = text.trim();
  if (type === 'boolean') return trimmed === 'true' ? true : trimmed === 'false' ? false : null;
  if (type === 'number') {
    const n = trimmed === '' ? Number.NaN : Number(trimmed.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return values?.includes(trimmed) ? trimmed : null;
}

/** A rule as a DSL leaf; null when its value does not fit the feature (the builder flags it). */
export function ruleToLeaf(rule: Rule): GateCondition | null {
  if (rule.op === 'isNull') return { feature: rule.feature, isNull: true };
  if (rule.op === 'in') {
    const parts = rule.value
      .split(',')
      .filter((part) => part.trim() !== '')
      .map((part) => scalar(rule.feature, part));
    if (parts.length === 0 || parts.some((part) => part === null)) return null;
    return { feature: rule.feature, in: parts as Scalar[] };
  }
  const value = scalar(rule.feature, rule.value);
  if (value === null) return null;
  if (['gt', 'gte', 'lt', 'lte'].includes(rule.op) && typeof value !== 'number') return null;
  return { feature: rule.feature, [rule.op]: value } as GateCondition;
}

/** The gate the engine reads; null while a rule is incomplete or the condition is invalid. */
export function toGate(draft: GateDraft): Gate | null {
  const { id, effect, reason } = draft;
  let when: GateCondition | null;
  if (draft.mode === 'advanced') when = draft.when;
  else {
    const leaves = draft.rules.map(ruleToLeaf);
    if (leaves.length === 0 || leaves.some((leaf) => leaf === null)) return null;
    const valid = leaves as GateCondition[];
    when =
      valid.length === 1
        ? (valid[0] as GateCondition)
        : draft.match === 'all'
          ? { all: valid }
          : { any: valid };
  }
  return GateConditionSchema.safeParse(when).success ? { id, effect, reason, when } : null;
}

const leafRule = (condition: GateCondition): Rule | null => {
  if (!('feature' in condition)) return null;
  const op = OPERATORS.find((candidate) => condition[candidate] !== undefined);
  if (!op) return null;
  const raw = condition[op];
  if (op === 'isNull') return raw === true ? { feature: condition.feature, op, value: '' } : null;
  return { feature: condition.feature, op, value: Array.isArray(raw) ? raw.join(', ') : String(raw) };
};

/** A stored gate in the builder: rules when its shape allows, else read-only (advanced). */
export function fromGate(gate: Gate): GateDraft {
  const { id, effect, reason, when } = gate;
  const single = leafRule(when);
  if (single) return { id, effect, reason, mode: 'rules', match: 'all', rules: [single] };
  for (const match of ['all', 'any'] as const) {
    if (match in when) {
      const rules = (when as Record<typeof match, readonly GateCondition[]>)[match].map(leafRule);
      if (rules.every((rule) => rule !== null)) {
        return { id, effect, reason, mode: 'rules', match, rules: rules as Rule[] };
      }
    }
  }
  return { id, effect, reason, mode: 'advanced', when };
}
