import type { SystemInfo } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../platform/clock/clock.module.ts';
import { describeSystem } from '../domain/system-info.ts';
import { BUILD_INFO_PROVIDER, type BuildInfoProvider } from './ports.ts';

/** Query use case: single `execute`, depends only on ports (coding-standards §2). */
@Injectable()
export class GetSystemInfoQuery {
  constructor(
    @Inject(BUILD_INFO_PROVIDER) private readonly buildInfo: BuildInfoProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  execute(): SystemInfo {
    return describeSystem(this.buildInfo.get(), this.clock.now());
  }
}
