import { fixedClock, MemberRoleChanged, UserSignedUp } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { AuditLogger } from './audit-logger.ts';
import { IdentityAuditSubscriber } from './identity-audit.subscriber.ts';
import { InMemoryAuditLog } from './testing.ts';

const clock = fixedClock('2026-10-15T09:00:00.000Z');
const meta = {
  context: { ip: '203.0.113.9', userAgent: 'Vitest' },
  attempt: 1,
  signal: new AbortController().signal,
  logger: {} as never,
};

describe('IdentityAuditSubscriber', () => {
  it('writes one audit entry per event, keyed by the event id, with the request facts', async () => {
    const log = new InMemoryAuditLog();
    const subscriber = new IdentityAuditSubscriber(new AuditLogger(log, clock));
    const event = MemberRoleChanged.create({
      payload: { memberId: '01990000-0000-7000-8000-000000000001', from: 'member', to: 'admin' },
      orgId: '01990000-0000-7000-8000-000000000002',
      actor: { type: 'api_key', id: 'key-1' },
      correlationId: 'req-1',
      clock: fixedClock('2026-10-15T08:00:00.000Z'),
    });
    await subscriber.record(event, meta);
    await subscriber.record(event, meta);
    expect(log.entries).toEqual([
      expect.objectContaining({
        id: event.id,
        action: 'identity.member_role_changed',
        organizationId: '01990000-0000-7000-8000-000000000002',
        actorType: 'api_key',
        actorId: 'key-1',
        entityType: 'member',
        entityId: '01990000-0000-7000-8000-000000000001',
        metadata: { from: 'member', to: 'admin' },
        ip: '203.0.113.9',
        userAgent: 'Vitest',
        occurredAt: new Date('2026-10-15T08:00:00.000Z'),
      }),
    ]);
  });

  it('records platform events (sign-up) without a workspace', async () => {
    const log = new InMemoryAuditLog();
    const event = UserSignedUp.create({
      payload: { userId: '01990000-0000-7000-8000-000000000003' },
      orgId: null,
      actor: { type: 'system', id: null },
      correlationId: 'req-2',
      clock,
    });
    await new IdentityAuditSubscriber(new AuditLogger(log, clock)).record(event, { ...meta, context: {} });
    expect(log.entries[0]).toMatchObject({
      organizationId: null,
      actorType: 'system',
      ip: null,
      entityType: 'user',
    });
  });
});
