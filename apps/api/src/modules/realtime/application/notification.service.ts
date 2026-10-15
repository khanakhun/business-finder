import type { ApiEnv } from '@bf/config';
import { NOTIFICATION_CREATED, NOTIFICATION_TYPES, type NotificationType } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { MemberDirectory, SYSTEM_MAILER, type SystemMailer } from '../../identity/index.ts';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import { notificationCopy } from './notification-copy.ts';
import {
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  type NotificationPreferenceRepository,
  type NotificationRepository,
  type PreferenceRecord,
} from './notification-ports.ts';
import { RealtimePublisher } from './realtime-publisher.ts';

export interface NotifyInput {
  readonly organizationId: string;
  /** Specific users, or every member of the workspace. */
  readonly recipients: 'members' | readonly string[];
  /** Users never notified (e.g. the person who performed the action). */
  readonly exclude?: readonly string[];
  readonly type: NotificationType;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly entity?: { readonly type: string; readonly id: string };
  /** Dashboard path, e.g. `/settings/members`. */
  readonly link?: `/${string}`;
  /** The domain event behind it: redelivery creates no duplicates. */
  readonly sourceEventId?: string;
}

/** Dashboard paths only: never another site (`//host`), a scheme, whitespace or backslashes. */
export const NOTIFICATION_LINK = /^\/(?!\/)[^\s\\]*$/;
const EMAIL_MARKER_TTL_SECONDS = 7 * 24 * 3600;

/** A user's effective delivery for one type: their saved choice, or the type's default. */
export function effectivePreference(
  type: NotificationType,
  saved: readonly PreferenceRecord[],
): PreferenceRecord {
  return saved.find((p) => p.type === type) ?? { type, ...NOTIFICATION_TYPES[type] };
}

/**
 * Creates notifications for subscribers (BF-012): one row per recipient who wants it in-app, a realtime nudge so
 * their bell refreshes, and an email when they opted in. Email is best effort: a failure is logged, the in-app
 * notification stays.
 */
@Injectable()
export class NotificationService {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY)
    private readonly preferences: NotificationPreferenceRepository,
    private readonly directory: MemberDirectory,
    private readonly realtime: RealtimePublisher,
    @Inject(SYSTEM_MAILER) private readonly mailer: SystemMailer,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  async notify(input: NotifyInput): Promise<{ created: number; emailed: number }> {
    if (input.link !== undefined && !NOTIFICATION_LINK.test(input.link)) {
      throw new Error(`Notification links must be dashboard paths, got ${JSON.stringify(input.link)}`);
    }
    const candidates =
      input.recipients === 'members'
        ? await this.directory.memberIds(input.organizationId)
        : [...input.recipients];
    const recipients = [...new Set(candidates)].filter((userId) => !input.exclude?.includes(userId));
    let created = 0;
    let emailed = 0;
    for (const userId of recipients) {
      // Only members of the workspace, even if a caller passed someone else.
      if (input.recipients !== 'members' && !(await this.directory.isMember(input.organizationId, userId)))
        continue;
      const preference = effectivePreference(
        input.type,
        await this.preferences.list(userId, input.organizationId),
      );
      // First time this event reaches this user? (A redelivered or replayed event must not email again.)
      let first = true;
      if (preference.inApp) {
        first = await this.createInApp(userId, input);
        if (first) created++;
      } else if (preference.email && input.sourceEventId) {
        first = await this.claimEmail(input.sourceEventId, userId);
      }
      if (preference.email && first && (await this.email(userId, input))) emailed++;
    }
    if (created > 0) {
      // The workspace stream is shared by every member's tabs: say only that notifications changed, not for whom.
      await this.realtime.publish(input.organizationId, {
        type: NOTIFICATION_CREATED,
        entity: 'notifications',
        entityId: input.organizationId,
      });
    }
    return { created, emailed };
  }

  private async claimEmail(sourceEventId: string, userId: string): Promise<boolean> {
    const claimed = await this.valkey.set(
      `bf:notify:email:${sourceEventId}:${userId}`,
      '1',
      'EX',
      EMAIL_MARKER_TTL_SECONDS,
      'NX',
    );
    return claimed === 'OK';
  }

  private async createInApp(userId: string, input: NotifyInput): Promise<boolean> {
    const record = await this.notifications.insert({
      organizationId: input.organizationId,
      userId,
      type: input.type,
      titleKey: `notifications.types.${input.type}.title`,
      bodyKey: `notifications.types.${input.type}.body`,
      params: { ...input.params },
      entityType: input.entity?.type ?? null,
      entityId: input.entity?.id ?? null,
      link: input.link ?? null,
      sourceEventId: input.sourceEventId ?? null,
    });
    return record !== undefined;
  }

  private async email(userId: string, input: NotifyInput): Promise<boolean> {
    const contact = await this.directory.contact(userId);
    if (!contact) return false;
    const copy = notificationCopy(input.type, contact.locale, input.params ?? {});
    try {
      await this.mailer.sendNotification({
        to: contact.email,
        locale: contact.locale,
        title: copy.title,
        body: copy.body,
        url: input.link ? `${(this.env as ApiEnv).APP_URL}${input.link}` : null,
      });
      return true;
    } catch (error) {
      this.logger.warn({ err: error, type: input.type }, 'notification email failed');
      return false;
    }
  }
}
