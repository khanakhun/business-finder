import type { Logger } from '@bf/observability';
import { metrics } from '@bf/observability';
import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { LOGGER } from '../../platform/logging/logger.ts';
import { AnyMember, Ctx } from '../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { ApiRoute } from '../../platform/validation/api-route.decorator.ts';
import { RealtimePublisher, toSse } from '../application/realtime-publisher.ts';
import { ConnectionLimiter } from '../infrastructure/connection-limiter.ts';
import { RealtimeMultiplexer } from '../infrastructure/realtime-multiplexer.ts';
import { compareStreamIds, isStreamId, serveSse } from './sse.ts';

/**
 * Streams are closed after this long; the browser reconnects (with `Last-Event-ID`, nothing is lost) and the
 * credentials are checked again, so a revoked session or removed member stops receiving events within minutes.
 */
const MAX_STREAM_MS = 5 * 60_000;

const connections = () =>
  metrics.gauge({ name: 'bf_realtime_connections', help: 'Open realtime SSE connections in this process' });
const closes = () =>
  metrics.counter({
    name: 'bf_realtime_disconnects_total',
    help: 'Realtime SSE disconnections by reason',
    labelNames: ['reason'],
  });

/** `GET /v1/realtime`: the active workspace's live events (api.md §7). */
@ApiTags('realtime')
@Controller('realtime')
export class RealtimeController {
  constructor(
    private readonly publisher: RealtimePublisher,
    private readonly multiplexer: RealtimeMultiplexer,
    private readonly limiter: ConnectionLimiter,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Get()
  @AnyMember()
  @ApiProduces('text/event-stream')
  @ApiRoute({
    summary: 'Server-sent events of the active workspace (Last-Event-ID replays up to 1000 missed events)',
    operationId: 'streamRealtime',
    response: { status: 200, schema: null },
    errors: [401, 403, 429],
  })
  async stream(@Ctx() auth: AuthContext, @Req() req: Request, @Res() res: Response): Promise<void> {
    // The workspace comes from the credentials only (never from the request), so streams cannot cross workspaces.
    const orgId = auth.orgId as string;
    const release = this.limiter.acquire(auth.userId ?? auth.apiKeyId ?? 'unknown');
    // Browsers send Last-Event-ID on their own reconnects; a fresh EventSource passes it as a query parameter.
    const header = req.headers['last-event-id'];
    const query = typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined;
    const candidate = (Array.isArray(header) ? header[0] : header) ?? query;
    const lastEventId = candidate && isStreamId(candidate) ? candidate : undefined;
    connections().inc();
    try {
      await serveSse(req, res, {
        lastEventId,
        compareIds: compareStreamIds,
        maxDurationMs: MAX_STREAM_MS,
        replay: (after) => this.publisher.replay(orgId, after),
        subscribe: (push) =>
          this.multiplexer.subscribe(orgId, (message) =>
            // Messages published while the Valkey subscription was down are lost: tell clients to refetch.
            push(
              message === 'resync' ? { event: 'resync', data: { reason: 'reconnected' } } : toSse(message),
            ),
          ),
        onClose: (reason) => {
          release();
          connections().dec();
          closes().inc({ reason });
        },
      });
    } catch (error) {
      // serveSse already closed the stream and ran onClose (release, metrics).
      this.logger.warn({ err: error }, 'realtime stream failed');
    }
  }
}
