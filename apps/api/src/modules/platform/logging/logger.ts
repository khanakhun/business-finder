import { createLogger, type Logger, metrics } from '@bf/observability';
import { Inject, Injectable, type LoggerService, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export const LOGGER = Symbol('LOGGER');
export type { Logger };

export function createAppLogger(service: string, level: Logger['level'], env: string): Logger {
  return createLogger({
    service,
    level: level as never,
    env,
    version: process.env.npm_package_version ?? 'dev',
  });
}

/** Routes Nest's own logs (bootstrap, route mapping, lifecycle) through pino. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}
  log(message: unknown, context?: string) {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    this.logger.error({ context, stack: trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    this.logger.trace({ context }, String(message));
  }
}

const httpRequests = () =>
  metrics.counter({
    name: 'bf_http_requests_total',
    help: 'HTTP requests by method, route template and status class',
    labelNames: ['method', 'route', 'status'],
  });
const httpDuration = () =>
  metrics.histogram({
    name: 'bf_http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route'],
  });

/** One log line and RED metrics per request, labelled by route template (never the raw URL: cardinality). */
@Injectable()
export class HttpLoggingMiddleware implements NestMiddleware {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const started = performance.now();
    res.on('finish', () => {
      const seconds = (performance.now() - started) / 1000;
      // Route template, never the raw URL (label cardinality); Nest's 404 catch-all route counts as unmatched.
      const path = (req.route as { path?: string } | undefined)?.path;
      const routeTemplate = path && !path.includes('*') ? `${req.baseUrl}${path}` : 'unmatched';
      httpRequests().inc({
        method: req.method,
        route: routeTemplate,
        status: `${String(res.statusCode)[0]}xx`,
      });
      httpDuration().observe({ method: req.method, route: routeTemplate }, seconds);
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      this.logger[level](
        {
          method: req.method,
          route: routeTemplate,
          status: res.statusCode,
          durationMs: Math.round(seconds * 1000),
        },
        'request completed',
      );
    });
    next();
  }
}
