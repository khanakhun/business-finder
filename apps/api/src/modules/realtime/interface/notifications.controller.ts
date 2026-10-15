import {
  type NotificationPage,
  NotificationPageSchema,
  type NotificationPreferences,
  NotificationPreferencesSchema,
  NotificationQuerySchema,
  type TestNotificationAccepted,
  TestNotificationAcceptedSchema,
  UpdateNotificationPreferencesRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AnyMember, Ctx } from '../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { ApiRoute } from '../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../platform/validation/zod-dto.ts';
import {
  ListNotificationsQuery,
  MarkNotificationsReadCommands,
  NotificationPreferencesUseCases,
  TriggerTestNotificationCommand,
} from '../application/notifications.use-cases.ts';

class NotificationQueryDto extends zodDto(NotificationQuerySchema) {}
class UpdatePreferencesBody extends zodDto(UpdateNotificationPreferencesRequestSchema) {}

/** The signed-in user's notifications in the active workspace, and their delivery preferences. */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly list: ListNotificationsQuery,
    private readonly read: MarkNotificationsReadCommands,
    private readonly preferences: NotificationPreferencesUseCases,
    private readonly testNotification: TriggerTestNotificationCommand,
  ) {}

  @Get()
  @AnyMember()
  @ApiRoute({
    summary: 'My notifications, newest first, with the unread count',
    operationId: 'listNotifications',
    query: NotificationQueryDto,
    response: { status: 200, schema: NotificationPageSchema },
    errors: [401, 403],
  })
  index(@Ctx() auth: AuthContext, @Query() query: NotificationQueryDto): Promise<NotificationPage> {
    return this.list.execute(auth, query);
  }

  @Post('read-all')
  @AnyMember()
  @ApiRoute({
    summary: 'Mark all my notifications read',
    operationId: 'markAllNotificationsRead',
    response: { status: 204, schema: null },
    errors: [401, 403],
  })
  async readAll(@Ctx() auth: AuthContext): Promise<void> {
    await this.read.markAllRead(auth);
  }

  @Post(':id/read')
  @AnyMember()
  @ApiRoute({
    summary: 'Mark one notification read',
    operationId: 'markNotificationRead',
    response: { status: 204, schema: null },
    errors: [401, 403, 404],
  })
  async readOne(@Ctx() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.read.markRead(auth, id);
  }

  @Get('preferences')
  @AnyMember()
  @ApiRoute({
    summary: 'My delivery preferences per notification type',
    operationId: 'getNotificationPreferences',
    response: { status: 200, schema: NotificationPreferencesSchema },
    errors: [401, 403],
  })
  getPreferences(@Ctx() auth: AuthContext): Promise<NotificationPreferences> {
    return this.preferences.get(auth);
  }

  @Put('preferences')
  @AnyMember()
  @ApiRoute({
    summary: 'Change my delivery preferences',
    operationId: 'updateNotificationPreferences',
    body: UpdatePreferencesBody,
    response: { status: 200, schema: NotificationPreferencesSchema },
    errors: [401, 403],
  })
  putPreferences(
    @Ctx() auth: AuthContext,
    @Body() body: UpdatePreferencesBody,
  ): Promise<NotificationPreferences> {
    return this.preferences.update(auth, body);
  }

  @Post('test')
  @AnyMember()
  @ApiRoute({
    summary: 'Send myself a test notification (development and E2E only; 404 in production)',
    operationId: 'triggerTestNotification',
    response: { status: 202, schema: TestNotificationAcceptedSchema },
    errors: [401, 403, 404],
  })
  test(@Ctx() auth: AuthContext): Promise<TestNotificationAccepted> {
    return this.testNotification.execute(auth);
  }
}
