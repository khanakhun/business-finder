import {
  BulkEnrichRequestSchema,
  type BulkEnrichResponse,
  BulkEnrichResponseSchema,
  type BusinessEnrichment,
  BusinessEnrichmentSchema,
  type BusinessWebsiteAudit,
  BusinessWebsiteAuditSchema,
  EnrichBusinessRequestSchema,
  type EnrichmentEstimate,
  EnrichmentEstimateSchema,
  type EnrichmentRun,
  EnrichmentRunSchema,
  NotFoundError,
  RateLimitedError,
  ValidationError,
  type WebsiteSnapshot,
  WebsiteSnapshotSchema,
} from '@bf/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ARTIFACT_STORAGE, type ObjectStorage } from '../../../platform/storage/object-storage.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { BulkEnrichCommand } from '../../application/enrichment.triggers.ts';
import {
  EnrichmentQueries,
  EstimateEnrichmentQuery,
  StartEnrichmentCommand,
} from '../../application/enrichment.use-cases.ts';
import { EnrichmentOrchestrator } from '../../application/run-orchestrator.ts';

class EnrichBody extends zodDto(EnrichBusinessRequestSchema) {}
class BulkBody extends zodDto(BulkEnrichRequestSchema) {}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,200}$/;

/** A caller's key, namespaced (`user:`): it can never collide with the keys of automatic runs. */
function idempotencyKey(key: string | undefined): string | null {
  if (key === undefined) return null;
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new ValidationError('Invalid Idempotency-Key.', [
      { path: ['Idempotency-Key'], message: '8–200 characters [A-Za-z0-9_.:-]' },
    ]);
  }
  return `user:${key}`;
}

/** Screenshots are a few hundred KiB; anything far larger is not one of ours. */
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

/** Routes guarantee an active workspace (`@RequirePermission`); reaching here without one is a wiring bug. */
function workspaceOf(auth: AuthContext): string {
  if (!auth.orgId) throw new Error('Enrichment route reached without an active workspace');
  return auth.orgId;
}

/** Enrichment of one business (BF-027): start, status, website facts and screenshots. */
// "Not crawled yet" is a normal state, not an error: 200 with a null snapshot (no 404 in every browser console).
const WebsiteSnapshotResultSchema = z
  .object({ snapshot: WebsiteSnapshotSchema.nullable() })
  .meta({ id: 'WebsiteSnapshotResult' });

@ApiTags('enrichment')
@Controller('businesses')
export class BusinessEnrichmentController {
  constructor(
    private readonly start: StartEnrichmentCommand,
    private readonly queries: EnrichmentQueries,
    @Inject(ARTIFACT_STORAGE) private readonly artifacts: ObjectStorage,
  ) {}

  @Post(':id/enrich')
  @RequirePermission('business:write')
  @ApiRoute({
    summary:
      'Enrich a business now: plans the steps (dependencies added, fresh ones skipped unless `force`) and starts ' +
      'a run. `Idempotency-Key` returns the same run; a run already open for the business is returned (200).',
    operationId: 'enrichBusiness',
    body: EnrichBody,
    response: { status: 201, schema: EnrichmentRunSchema },
    errors: [400, 401, 403, 404, 409, 422, 429],
  })
  async enrich(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) businessId: string,
    @Body() body: EnrichBody,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EnrichmentRun> {
    const organizationId = workspaceOf(auth);
    const outcome = await this.start.execute({
      organizationId,
      businessId,
      requestedBy: auth.userId,
      trigger: 'manual',
      ...(body.steps ? { steps: body.steps } : {}),
      force: body.force,
      idempotencyKey: idempotencyKey(key),
    });
    if (outcome.kind === 'rejected') {
      if (outcome.reason === 'busy') {
        throw new RateLimitedError('Too many enrichments are waiting in this workspace; try again later.');
      }
      throw new NotFoundError('Business', businessId);
    }
    res.status(outcome.kind === 'started' ? 201 : 200);
    return this.queries.run(organizationId, outcome.run.id);
  }

  @Get(':id/enrichment')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: "The business's latest enrichment run in this workspace and where each step stands",
    operationId: 'getBusinessEnrichment',
    response: { status: 200, schema: BusinessEnrichmentSchema },
    errors: [401, 403, 404],
  })
  enrichment(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) businessId: string,
  ): Promise<BusinessEnrichment> {
    return this.queries.business(workspaceOf(auth), businessId);
  }

  @Get(':id/website')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'What the business website showed at its latest crawl (snapshot null until crawled)',
    operationId: 'getBusinessWebsite',
    response: { status: 200, schema: WebsiteSnapshotResultSchema },
    errors: [401, 403, 404],
  })
  async website(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) businessId: string,
  ): Promise<{ snapshot: WebsiteSnapshot | null }> {
    return { snapshot: await this.queries.website(workspaceOf(auth), businessId) };
  }

  @Get(':id/website-audit')
  // Every role holds business:read; another workspace's business is a 404 (tested).
  @RequirePermission('business:read')
  @ApiRoute({
    summary:
      'The audit of the business website at its latest crawl: PageSpeed, visual grade, findings, status',
    operationId: 'getBusinessWebsiteAudit',
    response: { status: 200, schema: BusinessWebsiteAuditSchema },
    errors: [401, 403, 404],
  })
  websiteAudit(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) businessId: string,
  ): Promise<BusinessWebsiteAudit> {
    return this.queries.websiteAudit(workspaceOf(auth), businessId);
  }

  @Get(':id/website/screenshots/:kind')
  @RequirePermission('business:read')
  @ApiProduces('image/webp')
  @ApiRoute({
    summary: 'A screenshot of the business website from its latest crawl (`desktop` or `mobile`)',
    operationId: 'getBusinessWebsiteScreenshot',
    response: { status: 200, schema: null },
    errors: [400, 401, 403, 404],
  })
  async screenshot(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) businessId: string,
    @Param('kind') kind: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (kind !== 'desktop' && kind !== 'mobile') {
      throw new ValidationError('Unknown screenshot.', [{ path: ['kind'], message: 'desktop or mobile' }]);
    }
    const key = await this.queries.screenshotKey(workspaceOf(auth), businessId, kind);
    const image = await this.artifacts.get(key);
    if (!image || image.body.length > MAX_SCREENSHOT_BYTES) throw new NotFoundError('Screenshot', businessId);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="screenshot-${kind}.webp"`);
    // Rendered from an untrusted site: served as an image only.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new StreamableFile(image.body, { type: 'image/webp', length: image.body.length });
  }
}

/** Enrichment across businesses (BF-027): estimate and start in bulk, follow and cancel runs. */
@ApiTags('enrichment')
@Controller('enrichment')
export class EnrichmentController {
  constructor(
    private readonly bulk: BulkEnrichCommand,
    private readonly estimateQuery: EstimateEnrichmentQuery,
    private readonly queries: EnrichmentQueries,
    private readonly orchestrator: EnrichmentOrchestrator,
  ) {}

  @Post('estimate')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('business:read')
  @ApiRoute({
    summary:
      'What enriching these businesses would run and cost, against the monthly budget (no side effects)',
    operationId: 'estimateEnrichment',
    body: BulkBody,
    response: { status: 200, schema: EnrichmentEstimateSchema },
    errors: [400, 401, 403, 422],
  })
  estimate(@Ctx() auth: AuthContext, @Body() body: BulkBody): Promise<EnrichmentEstimate> {
    return this.estimateQuery.execute(workspaceOf(auth), {
      businessIds: body.businessIds,
      ...(body.steps ? { steps: body.steps } : {}),
      force: body.force,
    });
  }

  @Post('bulk')
  @HttpCode(202)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('business:write')
  @ApiRoute({
    summary:
      'Enrich several businesses: one run each (`Idempotency-Key` per request); refused ones say why ' +
      '(not tracked, budget, nothing to do)',
    operationId: 'enrichBusinesses',
    body: BulkBody,
    response: { status: 202, schema: BulkEnrichResponseSchema },
    errors: [400, 401, 403, 422],
  })
  enrichMany(
    @Ctx() auth: AuthContext,
    @Body() body: BulkBody,
    @Headers('idempotency-key') key: string | undefined,
  ): Promise<BulkEnrichResponse> {
    return this.bulk.execute(workspaceOf(auth), auth.userId, {
      businessIds: body.businessIds,
      ...(body.steps ? { steps: body.steps } : {}),
      force: body.force,
      idempotencyKey: idempotencyKey(key),
    });
  }

  @Get('runs/:id')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'An enrichment run with its steps',
    operationId: 'getEnrichmentRun',
    response: { status: 200, schema: EnrichmentRunSchema },
    errors: [401, 403, 404],
  })
  run(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) runId: string): Promise<EnrichmentRun> {
    return this.queries.run(workspaceOf(auth), runId);
  }

  @Post('runs/:id/cancel')
  @HttpCode(200)
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Cancel a run: queued steps are skipped, running ones are stopped at their next checkpoint',
    operationId: 'cancelEnrichmentRun',
    response: { status: 200, schema: EnrichmentRunSchema },
    errors: [401, 403, 404],
  })
  async cancel(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) runId: string): Promise<EnrichmentRun> {
    const organizationId = workspaceOf(auth);
    await this.queries.run(organizationId, runId);
    await this.orchestrator.cancel(runId);
    return this.queries.run(organizationId, runId);
  }
}
