import {
  CreatePolicyOverrideRequestSchema,
  type EffectivePolicy,
  EffectivePolicyListSchema,
  LawfulBasisListSchema,
  type LawfulBasisRecord,
  LawfulBasisRecordSchema,
  type OutreachChannel,
  OutreachChannelSchema,
  PolicyOverrideResultSchema,
  PolicyVersionSchema,
  ReviewPolicyRequestSchema,
  UpsertLawfulBasisRequestSchema,
} from '@bf/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { CompliancePolicies, type PolicyActor } from '../../application/compliance.policies.ts';

class ReviewBody extends zodDto(ReviewPolicyRequestSchema) {}
class OverrideBody extends zodDto(CreatePolicyOverrideRequestSchema) {}
class LawfulBasisBody extends zodDto(UpsertLawfulBasisRequestSchema) {}

const VersionList = z
  .object({ items: z.array(PolicyVersionSchema) })
  .meta({ id: 'CompliancePolicyVersionList' });

function actorOf(auth: AuthContext): PolicyActor {
  if (!auth.orgId) throw new Error('Compliance route reached without a workspace');
  return {
    organizationId: auth.orgId,
    userId: auth.userId,
    mayAutoSend: auth.permissions.has('outreach:auto_send'),
  };
}

/** Settings → Compliance (BF-049): policies, legal review, stricter-only overrides, lawful-basis records. */
@ApiTags('compliance')
@Controller('compliance')
export class CompliancePoliciesController {
  constructor(private readonly policies: CompliancePolicies) {}

  @Get('policies')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'The effective policy per jurisdiction and channel, with its review status and override',
    operationId: 'listCompliancePolicies',
    response: { status: 200, schema: EffectivePolicyListSchema },
    errors: [401, 403],
  })
  async list(@Ctx() auth: AuthContext): Promise<{ items: EffectivePolicy[] }> {
    return { items: await this.policies.effective(actorOf(auth).organizationId) };
  }

  @Get('policies/:jurisdiction/:channel/versions')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'The versions of a jurisdiction and channel’s policy (seeds and the workspace’s overrides)',
    operationId: 'listCompliancePolicyVersions',
    response: { status: 200, schema: VersionList },
    errors: [400, 401, 403],
  })
  async versions(
    @Ctx() auth: AuthContext,
    @Param('jurisdiction') jurisdiction: string,
    @Param('channel') channel: string,
  ) {
    const parsedChannel = OutreachChannelSchema.safeParse(channel);
    if (!/^([A-Z]{2}|\*)$/.test(jurisdiction) || !parsedChannel.success)
      throw new BadRequestException('Unknown jurisdiction or channel');
    return {
      items: await this.policies.versions(
        actorOf(auth).organizationId,
        jurisdiction,
        parsedChannel.data as OutreachChannel,
      ),
    };
  }

  @Post('policies/:id/review')
  @HttpCode(200)
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'Record a legal review of a seeded policy (and, for owners who may, turn on automatic sending)',
    operationId: 'reviewCompliancePolicy',
    body: ReviewBody,
    response: { status: 200, schema: PolicyVersionSchema },
    errors: [400, 401, 403, 404, 422],
  })
  review(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReviewBody) {
    return this.policies.review(actorOf(auth), id, body);
  }

  @Post('overrides')
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'A stricter-only override of a policy for the workspace, with its impact',
    operationId: 'createCompliancePolicyOverride',
    body: OverrideBody,
    response: { status: 201, schema: PolicyOverrideResultSchema },
    errors: [400, 401, 403, 404, 422],
  })
  override(@Ctx() auth: AuthContext, @Body() body: OverrideBody) {
    return this.policies.override(actorOf(auth), body);
  }

  @Get('lawful-basis')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'The workspace’s lawful-basis records (legitimate-interest assessments…)',
    operationId: 'listLawfulBasis',
    response: { status: 200, schema: LawfulBasisListSchema },
    errors: [401, 403],
  })
  async lawfulBasis(@Ctx() auth: AuthContext): Promise<{ items: LawfulBasisRecord[] }> {
    return { items: await this.policies.listLawfulBasis(actorOf(auth).organizationId) };
  }

  @Post('lawful-basis')
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'A new draft lawful-basis record',
    operationId: 'createLawfulBasis',
    body: LawfulBasisBody,
    response: { status: 201, schema: LawfulBasisRecordSchema },
    errors: [400, 401, 403, 422],
  })
  create(@Ctx() auth: AuthContext, @Body() body: LawfulBasisBody) {
    return this.policies.createLawfulBasis(actorOf(auth), body, 'en');
  }

  @Post('lawful-basis/from-template')
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'A new draft legitimate-interest assessment from the template (in the caller’s language)',
    operationId: 'createLawfulBasisFromTemplate',
    response: { status: 201, schema: LawfulBasisRecordSchema },
    errors: [401, 403],
  })
  fromTemplate(@Ctx() auth: AuthContext, @Headers('accept-language') language: string | undefined) {
    return this.policies.createLawfulBasis(
      actorOf(auth),
      null,
      language?.toLowerCase().startsWith('fr') ? 'fr' : 'en',
    );
  }

  @Patch('lawful-basis/:id')
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'Edit a draft lawful-basis record',
    operationId: 'updateLawfulBasis',
    body: LawfulBasisBody,
    response: { status: 200, schema: LawfulBasisRecordSchema },
    errors: [400, 401, 403, 404, 422],
  })
  update(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: LawfulBasisBody) {
    return this.policies.updateLawfulBasis(actorOf(auth), id, body);
  }

  @Post('lawful-basis/:id/approve')
  @HttpCode(200)
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'Approve a lawful-basis record (audited)',
    operationId: 'approveLawfulBasis',
    response: { status: 200, schema: LawfulBasisRecordSchema },
    errors: [401, 403, 404],
  })
  approve(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.policies.setLawfulBasisStatus(actorOf(auth), id, 'approved');
  }

  @Post('lawful-basis/:id/retire')
  @HttpCode(200)
  @RequirePermission('compliance:manage')
  @ApiRoute({
    summary: 'Retire a lawful-basis record (audited)',
    operationId: 'retireLawfulBasis',
    response: { status: 200, schema: LawfulBasisRecordSchema },
    errors: [401, 403, 404],
  })
  retire(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.policies.setLawfulBasisStatus(actorOf(auth), id, 'retired');
  }
}
