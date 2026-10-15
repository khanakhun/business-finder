import { type ReplayEventAccepted, ReplayEventAcceptedSchema, ReplayEventRequestSchema } from '@bf/contracts';
import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { ApiRoute } from '../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../platform/validation/zod-dto.ts';
import { ReplayEventCommand } from '../application/replay-event.command.ts';

class ReplayEventBody extends zodDto(ReplayEventRequestSchema) {}

/** Operational tools for the workspace's domain events (BF-012). */
@ApiTags('system')
@Controller('events')
export class EventsController {
  constructor(private readonly replayEvent: ReplayEventCommand) {}

  @Post(':eventId/replay')
  // settings:manage gates the route; the use case further requires the owner role.
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Deliver a recorded event to one subscriber again (workspace owners)',
    operationId: 'replayEvent',
    body: ReplayEventBody,
    response: { status: 202, schema: ReplayEventAcceptedSchema },
    errors: [401, 403, 404, 409],
  })
  replay(
    @Ctx() auth: AuthContext,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
    @Body() body: ReplayEventBody,
  ): Promise<ReplayEventAccepted> {
    return this.replayEvent.execute(auth, eventId, body.subscriberId);
  }
}
