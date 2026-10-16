import { metricsHandler } from '@bf/observability';
import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';

/** Prometheus scrape endpoint (not under /v1, not in the public API docs). */
@ApiExcludeController()
@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  @Get()
  async scrape(@Res() res: Response): Promise<void> {
    const { contentType, body } = await metricsHandler();
    res.type(contentType).send(body);
  }
}
