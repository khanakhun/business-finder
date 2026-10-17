import {
  EnrollmentListSchema,
  EnrollmentSchema,
  EnrollRequestSchema,
  EnrollResultSchema,
  SaveSequenceRequestSchema,
  SequenceListSchema,
  SequenceSchema,
} from '@bf/contracts';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MemberDirectory } from '../../../identity/index.ts';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import type { DraftActor } from '../../application/drafting/drafts.service.ts';
import { EnrollmentsService } from '../../application/sequences/enrollments.service.ts';
import { SequencesService } from '../../application/sequences/sequences.service.ts';

class SaveBody extends zodDto(SaveSequenceRequestSchema) {}
class EnrollBody extends zodDto(EnrollRequestSchema) {}

/**
 * Sequences (BF-053): versioned follow-up definitions (managing them needs `templates:manage`), enrollments of
 * businesses (compliance-previewed; one running sequence per business), and their pause, resume and stop.
 */
@ApiTags('outreach')
@Controller()
export class SequencesController {
  constructor(
    private readonly sequences: SequencesService,
    private readonly enrollments: EnrollmentsService,
    private readonly members: MemberDirectory,
  ) {}

  private async actor(auth: AuthContext): Promise<DraftActor> {
    if (!auth.orgId) throw new Error('Sequence route reached without a workspace');
    const contact = auth.userId ? await this.members.contact(auth.userId) : undefined;
    return {
      organizationId: auth.orgId,
      userId: auth.userId,
      locale: contact?.locale === 'fr' ? 'fr' : 'en',
    };
  }

  @Get('sequences')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'The workspace’s sequences (head version, running enrollments)',
    operationId: 'listSequences',
    response: { status: 200, schema: SequenceListSchema },
    errors: [401, 403],
  })
  async list(@Ctx() auth: AuthContext) {
    return { items: await this.sequences.list(await this.actor(auth)) };
  }

  @Post('sequences')
  @RequirePermission('templates:manage')
  @ApiRoute({
    summary: 'Create a sequence (a draft; the safety rails are checked)',
    operationId: 'createSequence',
    body: SaveBody,
    response: { status: 201, schema: SequenceSchema },
    errors: [400, 401, 403, 422],
  })
  async create(@Ctx() auth: AuthContext, @Body() body: SaveBody) {
    return this.sequences.create(await this.actor(auth), body);
  }

  @Get('sequences/:id')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'A sequence at its head version',
    operationId: 'getSequence',
    response: { status: 200, schema: SequenceSchema },
    errors: [401, 403, 404],
  })
  async get(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sequences.get(await this.actor(auth), id);
  }

  @Put('sequences/:id')
  @RequirePermission('templates:manage')
  @ApiRoute({
    summary: 'Save a sequence as its next version (running enrollments keep theirs)',
    operationId: 'updateSequence',
    body: SaveBody,
    response: { status: 200, schema: SequenceSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async update(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaveBody) {
    return this.sequences.update(await this.actor(auth), id, body);
  }

  @Post('sequences/:id/activate')
  @HttpCode(200)
  @RequirePermission('templates:manage')
  @ApiRoute({
    summary: 'Activate a sequence (businesses can be enrolled)',
    operationId: 'activateSequence',
    response: { status: 200, schema: SequenceSchema },
    errors: [401, 403, 404, 422],
  })
  async activate(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sequences.activate(await this.actor(auth), id);
  }

  @Post('sequences/:id/archive')
  @HttpCode(200)
  @RequirePermission('templates:manage')
  @ApiRoute({
    summary: 'Archive a sequence (no new enrollments; running ones continue)',
    operationId: 'archiveSequence',
    response: { status: 200, schema: SequenceSchema },
    errors: [401, 403, 404],
  })
  async archive(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sequences.archive(await this.actor(auth), id);
  }

  @Post('sequences/:id/enroll')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary:
      'Enroll businesses (≤ 100) or attach after a first email; blocked ones are reported, not enrolled',
    operationId: 'enrollInSequence',
    body: EnrollBody,
    response: { status: 201, schema: EnrollResultSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async enroll(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: EnrollBody) {
    return this.enrollments.enroll(await this.actor(auth), id, body);
  }

  @Get('enrollments')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'Enrollments of a business or a sequence, newest first, with their trail',
    operationId: 'listEnrollments',
    response: { status: 200, schema: EnrollmentListSchema },
    errors: [400, 401, 403],
  })
  async enrollmentsOf(
    @Ctx() auth: AuthContext,
    @Query('businessId', new ParseUUIDPipe({ optional: true })) businessId: string | undefined,
    @Query('sequenceId', new ParseUUIDPipe({ optional: true })) sequenceId: string | undefined,
  ) {
    return { items: await this.enrollments.list(await this.actor(auth), { businessId, sequenceId }) };
  }

  @Post('enrollments/:id/pause')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Pause an enrollment',
    operationId: 'pauseEnrollment',
    response: { status: 200, schema: EnrollmentSchema },
    errors: [401, 403, 404, 409],
  })
  async pause(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.enrollments.pause(await this.actor(auth), id);
  }

  @Post('enrollments/:id/resume')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Resume a paused enrollment',
    operationId: 'resumeEnrollment',
    response: { status: 200, schema: EnrollmentSchema },
    errors: [401, 403, 404, 409],
  })
  async resume(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.enrollments.resume(await this.actor(auth), id);
  }

  @Post('enrollments/:id/stop')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Stop an enrollment for good',
    operationId: 'stopEnrollment',
    response: { status: 200, schema: EnrollmentSchema },
    errors: [401, 403, 404, 409],
  })
  async stop(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.enrollments.stop(await this.actor(auth), id);
  }
}
