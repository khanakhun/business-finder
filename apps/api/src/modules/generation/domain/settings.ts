import type { EngineId, GenerationSettings, GenerationWorkspaceSettings } from '@bf/contracts';

// A workspace's generation settings (BF-046): what it stored, over the deployment's defaults, kept to the engines this
// deployment has (an engine switched off later drops out of the settings instead of breaking every batch). Pure.

export const MAX_CONCURRENCY = 20;

export interface SettingsProblem {
  readonly path: (string | number)[];
  readonly message: string;
  readonly code: string;
}

const pick = <V>(record: Partial<Record<EngineId, V>>, keep: ReadonlySet<EngineId>) =>
  Object.fromEntries(Object.entries(record).filter(([engine]) => keep.has(engine as EngineId))) as Partial<
    Record<EngineId, V>
  >;

/** The settings in force: the stored ones, else the defaults, limited to the registered engines. */
export function effectiveSettings(
  defaults: GenerationSettings,
  stored: GenerationWorkspaceSettings | undefined,
  registered: readonly EngineId[],
): GenerationWorkspaceSettings {
  const base: GenerationWorkspaceSettings = stored ?? {
    ...defaults,
    defaultRunMode: 'parallel',
    presets: [],
  };
  const available = new Set(registered);
  const allowed = base.allowedEngines.filter((engine) => available.has(engine));
  const allowedEngines = allowed.length > 0 ? allowed : defaults.allowedEngines;
  const keep = new Set(allowedEngines);
  return {
    ...base,
    allowedEngines,
    defaultEngine:
      base.defaultEngine === 'auto' || keep.has(base.defaultEngine) ? base.defaultEngine : 'auto',
    failoverChain: base.failoverChain.filter((engine) => keep.has(engine)),
    engineConcurrency: pick(base.engineConcurrency, keep),
    engineBudgetsUsd: { ...defaults.engineBudgetsUsd, ...pick(base.engineBudgetsUsd, keep) },
  };
}

/** Why an update cannot be saved (empty: it can). */
export function settingsProblems(
  settings: GenerationWorkspaceSettings,
  registered: readonly EngineId[],
): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  const available = new Set(registered);
  const allowed = new Set(settings.allowedEngines);
  settings.allowedEngines.forEach((engine, index) => {
    if (!available.has(engine))
      problems.push({
        path: ['allowedEngines', index],
        message: 'Engine not on this deployment',
        code: 'engine',
      });
  });
  if (settings.defaultEngine !== 'auto' && !allowed.has(settings.defaultEngine))
    problems.push({ path: ['defaultEngine'], message: 'Default engine must be allowed', code: 'engine' });
  const seen = new Set<EngineId>();
  settings.failoverChain.forEach((engine, index) => {
    if (!allowed.has(engine))
      problems.push({
        path: ['failoverChain', index],
        message: 'Failover engines must be allowed',
        code: 'engine',
      });
    if (seen.has(engine))
      problems.push({ path: ['failoverChain', index], message: 'Each engine once', code: 'duplicate' });
    seen.add(engine);
  });
  for (const [engine, limit] of Object.entries(settings.engineConcurrency)) {
    if (!allowed.has(engine as EngineId))
      problems.push({ path: ['engineConcurrency', engine], message: 'Engine not allowed', code: 'engine' });
    if ((limit ?? 0) > MAX_CONCURRENCY)
      problems.push({
        path: ['engineConcurrency', engine],
        message: `At most ${MAX_CONCURRENCY}`,
        code: 'too_big',
      });
  }
  const ids = new Set<string>();
  settings.presets.forEach((preset, index) => {
    if (ids.has(preset.id))
      problems.push({ path: ['presets', index, 'id'], message: 'Each preset id once', code: 'duplicate' });
    ids.add(preset.id);
  });
  return problems;
}
