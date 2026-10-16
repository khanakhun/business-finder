import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEvent, getEventDefinition, registeredEvents } from './events.ts';
import { BusinessId, isUuidV7, newId } from './ids.ts';
import { fixedClock } from './time.ts';

const businessCreated = defineEvent('test_business.created', 1, z.object({ businessId: BusinessId }));

describe('defineEvent', () => {
  const clock = fixedClock('2026-10-14T12:00:00.000Z');
  const orgId = newId();

  it('creates validated envelopes with a fresh id and the clock time', () => {
    const businessId = newId<'BusinessId'>();
    const event = businessCreated.create({
      payload: { businessId },
      orgId,
      actor: { type: 'user', id: 'u1' },
      correlationId: 'corr-1',
      clock,
    });
    expect(event).toEqual({
      id: expect.any(String),
      type: 'test_business.created',
      version: 1,
      occurredAt: '2026-10-14T12:00:00.000Z',
      orgId,
      actor: { type: 'user', id: 'u1' },
      correlationId: 'corr-1',
      causationId: null,
      payload: { businessId },
    });
    expect(isUuidV7(event.id)).toBe(true);
    expect(businessCreated.schema.safeParse(event).success).toBe(true);
  });

  it('rejects invalid payloads and envelopes', () => {
    expect(() =>
      businessCreated.create({
        payload: { businessId: 'nope' } as never,
        orgId: null,
        actor: { type: 'system', id: null },
        correlationId: 'c',
        clock,
      }),
    ).toThrow();
    const valid = businessCreated.create({
      payload: { businessId: newId<'BusinessId'>() },
      orgId: null,
      actor: { type: 'job', id: 'job-1' },
      correlationId: 'c',
      causationId: 'cause-1',
      clock,
    });
    expect(valid.causationId).toBe('cause-1');
    expect(businessCreated.schema.safeParse({ ...valid, type: 'other.type' }).success).toBe(false);
    expect(businessCreated.schema.safeParse({ ...valid, version: 2 }).success).toBe(false);
  });

  it('registers each type+version once', () => {
    expect(getEventDefinition('test_business.created', 1)).toBe(businessCreated);
    expect(getEventDefinition('test_business.created', 2)).toBeUndefined();
    expect(registeredEvents()).toContainEqual({ type: 'test_business.created', version: 1 });
    expect(() => defineEvent('test_business.created', 1, z.object({}))).toThrow(/already defined/);
    expect(defineEvent('test_business.created', 2, z.object({})).version).toBe(2);
  });

  it.each([
    ['Business.Created', 1],
    ['business', 1],
    ['business.created', 0],
    ['business.created', 1.5],
  ])('rejects %s v%s', (type, version) => {
    expect(() => defineEvent(type, version, z.object({}))).toThrow();
  });
});

describe('identity events and delivery jobs (BF-012)', () => {
  it('registers every identity event once, with id-only payloads', async () => {
    const { IDENTITY_EVENTS, MemberInvited } = await import('./identity-events.ts');
    expect(IDENTITY_EVENTS.map((e) => e.type)).toContain('identity.member_invited');
    const event = MemberInvited.create({
      payload: { invitationId: '01990000-0000-7000-8000-000000000001', role: 'member' },
      orgId: '01990000-0000-7000-8000-000000000002',
      actor: { type: 'api_key', id: 'key-1' },
      correlationId: 'req-1',
      clock: { now: () => new Date('2026-10-15T00:00:00Z') },
    });
    expect(event).toMatchObject({ type: 'identity.member_invited', version: 1, causationId: null });
    expect(() =>
      MemberInvited.schema.parse({ ...event, payload: { invitationId: 'x', role: 'member' } }),
    ).toThrow();
  });

  it('keys delivery jobs by subscriber id', async () => {
    const { EventDeliveryJob } = await import('./events.ts');
    const base = { idempotencyKey: 'e:s', orgId: null, eventId: '01990000-0000-7000-8000-000000000003' };
    expect(
      EventDeliveryJob.schema.safeParse({ ...base, subscriberId: 'workspace.audit-identity' }).success,
    ).toBe(true);
    expect(EventDeliveryJob.schema.safeParse({ ...base, subscriberId: 'NoDots' }).success).toBe(false);
  });
});
