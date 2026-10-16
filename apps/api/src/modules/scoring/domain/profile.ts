import {
  FEATURE_DEFINITIONS,
  type FeatureKey,
  type GateCondition,
  type ScoringProfileConfig,
  type Transform,
} from '@bf/contracts';

// Profile validation (BF-031): what the schema cannot say — a transform must fit its feature's type, an enum feature
// needs an `enumMap`, a number on another scale than 0–1 needs a transform, gate values must exist. Returns the
// problems (empty when the profile is usable), each with a JSON path.

export interface ProfileProblem {
  readonly path: string;
  readonly message: string;
}

const FITS: Record<'number' | 'boolean' | 'enum', readonly Transform['kind'][]> = {
  number: ['linear', 'inverse', 'piecewise', 'log'],
  boolean: ['boolean'],
  enum: ['enumMap'],
};

/** Units whose values are already on 0–1 (usable without a transform). */
const UNIT_SCALE = new Set(['share']);

function checkCondition(condition: GateCondition, path: string, problems: ProfileProblem[]): void {
  if ('all' in condition) {
    for (const [i, part] of condition.all.entries()) checkCondition(part, `${path}.all[${i}]`, problems);
    return;
  }
  if ('any' in condition) {
    for (const [i, part] of condition.any.entries()) checkCondition(part, `${path}.any[${i}]`, problems);
    return;
  }
  if ('not' in condition) {
    checkCondition(condition.not, `${path}.not`, problems);
    return;
  }
  const definition = FEATURE_DEFINITIONS[condition.feature];
  const values = [condition.eq, condition.neq, ...(condition.in ?? [])].filter(
    (value) => value !== undefined,
  );
  for (const value of values) {
    const fits =
      definition.type === 'enum'
        ? typeof value === 'string' && (definition.values ?? []).includes(value)
        : typeof value === (definition.type === 'number' ? 'number' : 'boolean');
    if (!fits) problems.push({ path, message: `${String(value)} is not a value of ${condition.feature}` });
  }
  const ordered = [condition.gt, condition.gte, condition.lt, condition.lte].some(
    (value) => value !== undefined,
  );
  if (ordered && definition.type !== 'number') {
    problems.push({ path, message: `${condition.feature} is not a number: it cannot be compared` });
  }
}

export function validateProfile(config: ScoringProfileConfig): ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  for (const [key, weight] of Object.entries(config.weights) as [FeatureKey, number][]) {
    if (weight === 0) continue;
    const definition = FEATURE_DEFINITIONS[key];
    const transform = config.transforms[key];
    if (transform && !FITS[definition.type].includes(transform.kind)) {
      problems.push({
        path: `transforms.${key}`,
        message: `A ${definition.type} feature cannot use ${transform.kind}`,
      });
    }
    if (!transform && definition.type === 'enum') {
      problems.push({ path: `transforms.${key}`, message: 'An enum feature needs an enumMap transform' });
    }
    if (!transform && definition.type === 'number' && !UNIT_SCALE.has(definition.unit)) {
      problems.push({
        path: `transforms.${key}`,
        message: 'This number is not on 0–1: it needs a transform',
      });
    }
    if (transform?.kind === 'enumMap') {
      for (const value of Object.keys(transform.map)) {
        if (!(definition.values ?? []).includes(value)) {
          problems.push({
            path: `transforms.${key}.map.${value}`,
            message: `${value} is not a value of ${key}`,
          });
        }
      }
    }
  }
  for (const key of Object.keys(config.transforms) as FeatureKey[]) {
    if (config.weights[key] === undefined) {
      problems.push({ path: `transforms.${key}`, message: 'A transform for a feature without a weight' });
    }
  }
  const ids = new Set<string>();
  config.gates.forEach((gate, i) => {
    if (ids.has(gate.id)) problems.push({ path: `gates[${i}].id`, message: `Duplicate gate id ${gate.id}` });
    ids.add(gate.id);
    checkCondition(gate.when, `gates[${i}].when`, problems);
  });
  return problems;
}
