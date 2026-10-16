import {
  ConflictError,
  FEATURE_FLAG_NAMES,
  FEATURE_FLAGS,
  type FeatureFlag,
  type FeatureFlags,
} from '@bf/contracts';

/** Deployment-level switches (`FEATURE_*` env values), by env name. */
export type DeploymentSwitches = Readonly<Record<string, unknown>>;

export interface FeatureFlagState {
  readonly enabled: boolean;
  readonly workspaceValue: boolean;
  readonly available: boolean;
}

/** False when the deployment turned the feature off; flags without an env switch are always available. */
export function isAvailable(flag: FeatureFlag, deployment: DeploymentSwitches): boolean {
  const definition = FEATURE_FLAGS[flag];
  return !('env' in definition) || deployment[definition.env] === true;
}

/** Effective value: on only when the deployment allows it **and** the workspace (or the default) wants it. */
export function featureState(
  flag: FeatureFlag,
  stored: FeatureFlags,
  deployment: DeploymentSwitches,
): FeatureFlagState {
  const workspaceValue = stored[flag] ?? FEATURE_FLAGS[flag].default;
  const available = isAvailable(flag, deployment);
  return { enabled: available && workspaceValue, workspaceValue, available };
}

export function featureStates(
  stored: FeatureFlags,
  deployment: DeploymentSwitches,
): Record<FeatureFlag, FeatureFlagState> {
  return Object.fromEntries(
    FEATURE_FLAG_NAMES.map((flag) => [flag, featureState(flag, stored, deployment)]),
  ) as Record<FeatureFlag, FeatureFlagState>;
}

/** A workspace cannot switch on what the deployment disabled (turning it off is always allowed). */
export function assertCanSet(changes: FeatureFlags, deployment: DeploymentSwitches): void {
  const refused = FEATURE_FLAG_NAMES.filter(
    (flag) => changes[flag] === true && !isAvailable(flag, deployment),
  );
  if (refused.length > 0) {
    throw new ConflictError(`Disabled for this deployment: ${refused.join(', ')}.`, {
      details: { reason: 'FEATURE_UNAVAILABLE', flags: refused },
    });
  }
}
