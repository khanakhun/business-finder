import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newId } from './ids.ts';
import { defineJob, getJobDefinition, JobPayloadBase } from './jobs.ts';

const enrich = defineJob('test-enrichment', 'enrich-business', { businessId: z.uuid() });

describe('defineJob', () => {
  const base = { idempotencyKey: 'enrich:b1:2026-10-14', orgId: newId() };

  it('extends the base payload', () => {
    const payload = enrich.schema.parse({ ...base, businessId: newId() });
    expect(payload.idempotencyKey).toBe(base.idempotencyKey);
    expect(enrich.schema.safeParse({ ...base }).success).toBe(false);
    expect(enrich.schema.safeParse({ businessId: newId(), orgId: null }).success).toBe(false);
  });

  it('validates traceparent and requestedBy', () => {
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    expect(JobPayloadBase.safeParse({ ...base, traceparent, requestedBy: newId() }).success).toBe(true);
    expect(JobPayloadBase.safeParse({ ...base, traceparent: 'nope' }).success).toBe(false);
  });

  it('registers queue/name pairs once', () => {
    expect(getJobDefinition('test-enrichment', 'enrich-business')).toBe(enrich);
    expect(getJobDefinition('test-enrichment', 'other')).toBeUndefined();
    expect(() => defineJob('test-enrichment', 'enrich-business', {})).toThrow(/already defined/);
    expect(() => defineJob('Bad Queue', 'x', {})).toThrow(/kebab-case/);
  });
});
