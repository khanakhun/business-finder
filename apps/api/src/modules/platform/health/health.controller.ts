import type { DbClient } from '@bf/db';
import {
  type ArgumentsHost,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
  HttpException,
  Inject,
  UseFilters,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, HealthIndicatorService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { DB_CLIENT } from '../db/db.module.ts';
import { AllowAnonymous } from '../security/auth.decorators.ts';
import { VALKEY } from '../valkey/valkey.module.ts';

const CHECK_TIMEOUT_MS = 2_000;

/** Terminus reports "not ready" by throwing a 503 carrying the health report; send that report, not a problem. */
@Catch(HttpException)
class HealthReportFilter implements ExceptionFilter {
  catch(error: HttpException, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(error.getStatus()).json(error.getResponse());
  }
}

/** `/health/live`: the process runs. `/health/ready`: dependencies answer (503 otherwise). ADR-0015. */
@ApiExcludeController()
@SkipThrottle()
@AllowAnonymous()
@UseFilters(HealthReportFilter)
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () =>
        this.indicators
          .check('database')
          .attempt(async () => {
            await this.db.execute(sql`SELECT 1`);
          })
          .withTimeout(CHECK_TIMEOUT_MS),
      () =>
        this.indicators
          .check('valkey')
          .attempt(async () => {
            await this.valkey.ping();
          })
          .withTimeout(CHECK_TIMEOUT_MS),
    ]);
  }
}
