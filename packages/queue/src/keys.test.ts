import { describe, expect, it } from 'vitest';
import { jobIdFor, keys } from './keys.ts';
import { GENERATION_JOB_OPTIONS, QUEUE_NAMES, QUEUES } from './registry.ts';

describe('keys', () => {
  it('derives BullMQ-safe job ids from idempotency keys', () => {
    expect(jobIdFor('ping', 'req-1:0')).toBe('ping__req-1_0');
    expect(jobIdFor('ping', 'a')).toBe(jobIdFor('ping', 'a'));
  });

  it('namespaces runner keys away from BullMQ', () => {
    expect(keys.idempotency('system', 'ping', 'k')).toBe('bf:job:idem:system:ping:k');
    expect(keys.cancel('system', 'j1')).toBe('bf:job:cancel:system:j1');
  });
});

describe('queue registry', () => {
  it('has kebab-case names, retries and bounded retention', () => {
    for (const name of QUEUE_NAMES) {
      const queue = QUEUES[name];
      expect(queue.name).toMatch(/^[a-z][a-z0-9-]*$/);
      // Generation runs are attempted once: the orchestrator retries and fails over (BF-039).
      if (queue.defaultJobOptions === GENERATION_JOB_OPTIONS)
        expect(queue.defaultJobOptions.attempts).toBe(1);
      else expect(queue.defaultJobOptions.attempts).toBeGreaterThan(1);
      expect(queue.defaultJobOptions.removeOnComplete).toBeTruthy();
      expect(queue.concurrency).toBeGreaterThan(0);
    }
  });
});
