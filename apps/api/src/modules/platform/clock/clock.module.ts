import { type Clock, systemClock } from '@bf/contracts';
import { Global, Module } from '@nestjs/common';

/** DI token for the Clock port; tests override it with `fixedClock()`. */
export const CLOCK = Symbol('CLOCK');
export type { Clock };

@Global()
@Module({ providers: [{ provide: CLOCK, useValue: systemClock }], exports: [CLOCK] })
export class ClockModule {}
