import type { BuildInfo } from '../domain/system-info.ts';

/** Port: where build facts come from (config today; could be a manifest file). */
export interface BuildInfoProvider {
  get(): BuildInfo;
}
export const BUILD_INFO_PROVIDER = Symbol('BuildInfoProvider');
