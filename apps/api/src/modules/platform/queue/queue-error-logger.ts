import { QUEUE_NAMES, QUEUES } from '@bf/queue';
import { getQueueToken } from '@nestjs/bullmq';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { LOGGER, type Logger } from '../logging/logger.ts';

/** BullMQ prints connection errors to the console when a queue has no `error` listener; log them instead. */
@Injectable()
export class QueueErrorLogger implements OnModuleInit {
  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    for (const key of QUEUE_NAMES) {
      const name = QUEUES[key].name;
      const queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
      let last = '';
      queue.on('error', (error: Error) => {
        if (error.message === last) return;
        last = error.message;
        this.logger.warn({ err: error, queue: name }, 'queue connection error');
      });
    }
  }
}
