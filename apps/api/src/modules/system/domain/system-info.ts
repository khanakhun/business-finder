import type { SystemInfo } from '@bf/contracts';

/** Facts about the running build, supplied by infrastructure (BuildInfo port). */
export interface BuildInfo {
  readonly name: string;
  readonly version: string;
  readonly commit: string | null;
  readonly env: SystemInfo['env'];
}

/** Pure: combines build facts with the current time. */
export function describeSystem(build: BuildInfo, now: Date): SystemInfo {
  return { ...build, time: now.toISOString() };
}
