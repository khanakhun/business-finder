import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { LOGGER } from '../../platform/logging/logger.ts';
import type { IdentityEvent, IdentityEvents } from '../application/ports.ts';

/** TODO(BF-012): replace with the transactional outbox; until then identity events are structured log lines. */
@Injectable()
export class LoggingIdentityEvents implements IdentityEvents {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  async publish(event: IdentityEvent, actor: { readonly userId: string | null }): Promise<void> {
    this.logger.info({ event, actorUserId: actor.userId }, event.type);
  }
}
