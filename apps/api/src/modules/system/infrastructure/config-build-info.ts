import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import type { BuildInfoProvider } from '../application/ports.ts';
import type { BuildInfo } from '../domain/system-info.ts';

/** Adapter: build facts from validated configuration. */
@Injectable()
export class ConfigBuildInfoProvider implements BuildInfoProvider {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  get(): BuildInfo {
    return {
      name: 'business-finder-api',
      version: this.env.APP_VERSION,
      commit: this.env.GIT_COMMIT ?? null,
      env: this.env.NODE_ENV,
    };
  }
}
