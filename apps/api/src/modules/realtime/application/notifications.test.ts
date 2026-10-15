import { ForbiddenError, fixedClock, NotFoundError, ROLE_PERMISSIONS, ValidationError } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberDirectory, SystemMailer } from '../../identity/index.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { NotificationService } from './notification.service.ts';
import { notificationCopy } from './notification-copy.ts';
import {
  ListNotificationsQuery,
  MarkNotificationsReadCommands,
  NotificationPreferencesUseCases,
  recipientOf,
  TriggerTestNotificationCommand,
} from './notifications.use-cases.ts';
import type { RealtimePublisher } from './realtime-publisher.ts';
import { InMemoryNotifications, InMemoryPreferences } from './testing.ts';

const ORG = '01990000-0000-7000-8000-0000000000a1';
const ANN = '01990000-0000-7000-8000-0000000000b1';
const BOB = '01990000-0000-7000-8000-0000000000b2';
const STRANGER = '01990000-0000-7000-8000-0000000000b3';

const session = (userId: string): AuthContext => ({
  method: 'session',
  userId,
  apiKeyId: null,
  orgId: ORG,
  role: 'member',
  permissions: ROLE_PERMISSIONS.member,
  crossOrigin: false,
  operator: false,
});

const directory = {
  memberIds: async () => [ANN, BOB],
  isMember: async (_org: string, userId: string) => userId !== STRANGER,
  contact: async (userId: string) =>
    userId === STRANGER
      ? undefined
      : {
          userId,
          name: userId === ANN ? 'Ann' : 'Bob',
          email: `${userId}@x.test`,
          locale: userId === ANN ? 'fr' : 'en',
        },
} as unknown as MemberDirectory;

let notifications: InMemoryNotifications;
let preferences: InMemoryPreferences;
let published: Array<{ orgId: string; type: string; payload: unknown }>;
let mailer: { sendNotification: ReturnType<typeof vi.fn> };
let service: NotificationService;
let emailMarkers: Set<string>;
const logger = { warn: vi.fn() } as unknown as Logger;

beforeEach(() => {
  notifications = new InMemoryNotifications();
  preferences = new InMemoryPreferences();
  published = [];
  mailer = { sendNotification: vi.fn(async () => undefined) };
  const realtime = {
    publish: async (orgId: string, input: { type: string; payload?: unknown }) => {
      published.push({ orgId, type: input.type, payload: input.payload });
      return {} as never;
    },
  } as unknown as RealtimePublisher;
  emailMarkers = new Set<string>();
  const valkey = {
    set: async (key: string) => {
      if (emailMarkers.has(key)) return null;
      emailMarkers.add(key);
      return 'OK';
    },
  };
  service = new NotificationService(
    notifications,
    preferences,
    directory,
    realtime,
    mailer as unknown as SystemMailer,
    { APP_URL: 'https://app.example' } as never,
    logger,
    valkey as never,
  );
});

describe('NotificationService', () => {
  it('fans out to members (minus exclusions), nudges each one, once per event', async () => {
    const input = {
      organizationId: ORG,
      recipients: 'members' as const,
      exclude: [BOB],
      type: 'member_joined' as const,
      params: { name: 'Bob' },
      link: '/settings/members' as const,
      sourceEventId: '01990000-0000-7000-8000-0000000000e1',
    };
    expect(await service.notify(input)).toEqual({ created: 1, emailed: 0 });
    expect(await service.notify(input)).toEqual({ created: 0, emailed: 0 });
    expect(notifications.rows).toHaveLength(1);
    expect(notifications.rows[0]).toMatchObject({
      userId: ANN,
      titleKey: 'notifications.types.member_joined.title',
      params: { name: 'Bob' },
    });
    // One anonymous nudge per notify call: the shared workspace stream never says who was notified.
    expect(published).toEqual([{ orgId: ORG, type: 'notification.created', payload: undefined }]);
  });

  it('follows preferences: email when opted in (localized, absolute link), nothing in-app when turned off', async () => {
    await preferences.upsert(ANN, ORG, [{ type: 'member_joined', inApp: false, email: true }]);
    const result = await service.notify({
      organizationId: ORG,
      recipients: [ANN],
      type: 'member_joined',
      params: { name: 'Bob' },
      link: '/settings/members',
    });
    expect(result).toEqual({ created: 0, emailed: 1 });
    expect(mailer.sendNotification).toHaveBeenCalledWith({
      to: `${ANN}@x.test`,
      locale: 'fr',
      title: 'Bob a rejoint l’espace de travail',
      body: 'Cette personne a accepté son invitation.',
      url: 'https://app.example/settings/members',
    });
  });

  it('does not email twice when an event is redelivered (with or without an in-app row)', async () => {
    await preferences.upsert(ANN, ORG, [{ type: 'member_joined', inApp: false, email: true }]);
    await preferences.upsert(BOB, ORG, [{ type: 'member_joined', inApp: true, email: true }]);
    const input = {
      organizationId: ORG,
      recipients: [ANN, BOB],
      type: 'member_joined' as const,
      params: { name: 'Cy' },
      sourceEventId: '01990000-0000-7000-8000-0000000000e2',
    };
    expect(await service.notify(input)).toEqual({ created: 1, emailed: 2 });
    expect(await service.notify(input)).toEqual({ created: 0, emailed: 0 });
    expect(mailer.sendNotification).toHaveBeenCalledTimes(2);
  });

  it('refuses links that are not dashboard paths', async () => {
    for (const link of ['//evil.example', '/\\evil', '/a b']) {
      await expect(
        service.notify({ organizationId: ORG, recipients: [ANN], type: 'system_test', link: link as '/x' }),
      ).rejects.toThrow(/dashboard paths/);
    }
  });

  it('never notifies non-members, and keeps going when an email fails', async () => {
    mailer.sendNotification.mockRejectedValueOnce(new Error('smtp down'));
    await preferences.upsert(ANN, ORG, [{ type: 'system_test', inApp: true, email: true }]);
    const result = await service.notify({
      organizationId: ORG,
      recipients: [STRANGER, ANN],
      type: 'system_test',
    });
    expect(result).toEqual({ created: 1, emailed: 0 });
    expect(notifications.rows.map((r) => r.userId)).toEqual([ANN]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('notification copy', () => {
  it('fills known placeholders and leaves unknown ones', () => {
    expect(notificationCopy('discovery_completed', 'en', { count: 12 }).body).toBe('12 businesses found.');
    expect(notificationCopy('reply_received', 'en', {}).title).toBe('New reply from {business}');
  });
});

describe('notification use cases', () => {
  const clock = fixedClock('2026-10-15T12:00:00.000Z');

  it('lists my notifications with the unread count and pages with a cursor', async () => {
    for (let i = 0; i < 3; i++)
      await service.notify({ organizationId: ORG, recipients: [ANN], type: 'system_test' });
    await service.notify({ organizationId: ORG, recipients: [BOB], type: 'system_test' });
    const query = new ListNotificationsQuery(notifications);
    const first = await query.execute(session(ANN), { limit: 2, unread: false });
    expect(first.items).toHaveLength(2);
    expect(first.unreadCount).toBe(3);
    const second = await query.execute(session(ANN), {
      limit: 2,
      unread: false,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    await expect(
      query.execute(session(ANN), { limit: 2, unread: false, cursor: 'nope' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('marks read (mine only) and all read', async () => {
    await service.notify({ organizationId: ORG, recipients: [ANN, BOB], type: 'system_test' });
    const [mine] = notifications.rows.filter((r) => r.userId === ANN);
    if (!mine) throw new Error('missing');
    const commands = new MarkNotificationsReadCommands(notifications, clock);
    await expect(commands.markRead(session(BOB), mine.id)).rejects.toBeInstanceOf(NotFoundError);
    await commands.markRead(session(ANN), mine.id);
    expect(await notifications.unreadCount(ORG, ANN)).toBe(0);
    await commands.markAllRead(session(BOB));
    expect(await notifications.unreadCount(ORG, BOB)).toBe(0);
  });

  it('returns every type with defaults and saves changes', async () => {
    const prefs = new NotificationPreferencesUseCases(preferences);
    expect((await prefs.get(session(ANN))).items).toContainEqual({
      type: 'reply_received',
      inApp: true,
      email: true,
    });
    const updated = await prefs.update(session(ANN), {
      items: [{ type: 'reply_received', inApp: true, email: false }],
    });
    expect(updated.items).toContainEqual({ type: 'reply_received', inApp: true, email: false });
  });

  it('is for signed-in users in a workspace; the test trigger is off in production', async () => {
    expect(() => recipientOf({ ...session(ANN), method: 'api_key', userId: null })).toThrow(ForbiddenError);
    expect(() => recipientOf({ ...session(ANN), orgId: null })).toThrow(ForbiddenError);
    const events = { record: vi.fn(async () => ({ id: '01990000-0000-7000-8000-0000000000e9' })) };
    const prod = new TriggerTestNotificationCommand(events as never, { NODE_ENV: 'production' } as never);
    await expect(prod.execute(session(ANN))).rejects.toBeInstanceOf(NotFoundError);
    const dev = new TriggerTestNotificationCommand(events as never, { NODE_ENV: 'development' } as never);
    expect(await dev.execute(session(ANN))).toEqual({ eventId: '01990000-0000-7000-8000-0000000000e9' });
  });
});
