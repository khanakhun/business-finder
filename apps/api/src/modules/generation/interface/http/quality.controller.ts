import {
  AcceptGenerationJobRequestSchema,
  type GenerationJob,
  type GenerationJobQuality,
  GenerationJobQualitySchema,
  GenerationJobSchema,
  RepairGenerationJobRequestSchema,
} from '@bf/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { toJob } from '../../application/generation.queries.ts';
import { GenerationReview, type ReviewActor } from '../../application/generation.review.ts';

class AcceptBody extends zodDto(AcceptGenerationJobRequestSchema) {}
class RepairBody extends zodDto(RepairGenerationJobRequestSchema) {}

function actorOf(auth: AuthContext): ReviewActor {
  if (!auth.orgId || !auth.userId) throw new Error('Review route reached without a member of a workspace');
  return { organizationId: auth.orgId, userId: auth.userId };
}

/** A generated version's quality (BF-045): the report and its screenshots, accept anyway, repair. */
@ApiTags('generation')
@Controller('generation-jobs/:id')
export class QualityController {
  constructor(private readonly review: GenerationReview) {}

  @Get('quality')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'The quality report of the job’s latest version (gates, score, decision, issues, screenshots)',
    operationId: 'getGenerationJobQuality',
    response: { status: 200, schema: GenerationJobQualitySchema },
    errors: [401, 403, 404],
  })
  async report(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GenerationJobQuality> {
    return { report: await this.review.report(actorOf(auth), id) };
  }

  @Get('quality/screenshots/:index')
  @RequirePermission('sites:read')
  @ApiProduces('image/png')
  @ApiRoute({
    summary: 'One of the screenshots the visual critic graded',
    operationId: 'getGenerationJobQualityScreenshot',
    response: { status: 200, schema: null },
    errors: [400, 401, 403, 404],
  })
  async screenshot(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const body = await this.review.screenshot(actorOf(auth), id, index);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new StreamableFile(body, { type: 'image/png', length: body.length });
  }

  @Post('accept')
  @HttpCode(200)
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary:
      'Publish a version the gates sent to review, with a reason (never when its schema or facts failed)',
    operationId: 'acceptGenerationJob',
    body: AcceptBody,
    response: { status: 200, schema: GenerationJobSchema },
    errors: [401, 403, 404, 409, 422],
  })
  async accept(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AcceptBody,
  ): Promise<GenerationJob> {
    return toJob(await this.review.accept(actorOf(auth), id, body.reason));
  }

  @Post('repair')
  @HttpCode(200)
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Ask for a repair of a reviewed version on its report’s issues (on another engine if given)',
    operationId: 'repairGenerationJob',
    body: RepairBody,
    response: { status: 200, schema: GenerationJobSchema },
    errors: [401, 403, 404, 409, 422],
  })
  async repair(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RepairBody,
  ): Promise<GenerationJob> {
    return toJob(await this.review.repair(actorOf(auth), id, body.engine));
  }
}
