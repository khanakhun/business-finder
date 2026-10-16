import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { AppMode } from '../platform/config/app-env.ts';
import { NotificationService } from './application/notification.service.ts';
import { NotificationSubscribers } from './application/notification.subscribers.ts';
import {
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_REPOSITORY,
} from './application/notification-ports.ts';
import {
  ListNotificationsQuery,
  MarkNotificationsReadCommands,
  NotificationPreferencesUseCases,
  TriggerTestNotificationCommand,
} from './application/notifications.use-cases.ts';
import { RealtimePublisher } from './application/realtime-publisher.ts';
import { ConnectionLimiter } from './infrastructure/connection-limiter.ts';
import {
  DrizzleNotificationPreferenceRepository,
  DrizzleNotificationRepository,
} from './infrastructure/drizzle-notifications.repository.ts';
import { RealtimeMultiplexer } from './infrastructure/realtime-multiplexer.ts';
import { NotificationsController } from './interface/notifications.controller.ts';
import { RealtimeController } from './interface/realtime.controller.ts';

/**
 * Realtime (BF-012): every process can publish workspace events (`RealtimePublisher`) and create notifications
 * (`NotificationService`, used by subscribers in the worker); the HTTP process serves the SSE stream through one
 * multiplexed Valkey subscription, and the notifications API.
 */
@Global()
@Module({})
export class RealtimeModule {
  private static readonly byMode = new Map<AppMode, DynamicModule>();

  /**
   * One definition per mode: modules importing this one (for its public services) share the instance the app
   * module creates instead of building a second one.
   */
  static forRoot(mode: AppMode): DynamicModule {
    let definition = RealtimeModule.byMode.get(mode);
    if (!definition) {
      definition = RealtimeModule.build(mode);
      RealtimeModule.byMode.set(mode, definition);
    }
    return definition;
  }

  private static build(mode: AppMode): DynamicModule {
    const http = mode !== 'worker';
    return {
      module: RealtimeModule,
      controllers: http ? [RealtimeController, NotificationsController] : [],
      providers: [
        RealtimePublisher,
        { provide: NOTIFICATION_REPOSITORY, useClass: DrizzleNotificationRepository },
        { provide: NOTIFICATION_PREFERENCE_REPOSITORY, useClass: DrizzleNotificationPreferenceRepository },
        NotificationService,
        NotificationSubscribers,
        ...(http
          ? [
              RealtimeMultiplexer,
              ConnectionLimiter,
              ListNotificationsQuery,
              MarkNotificationsReadCommands,
              NotificationPreferencesUseCases,
              TriggerTestNotificationCommand,
            ]
          : []),
      ],
      exports: [RealtimePublisher, NotificationService],
    };
  }
}
