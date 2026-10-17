import {
  type GenerationArtifactList,
  GenerationArtifactListSchema,
  type GenerationJobListQuery,
  GenerationJobListQuerySchema,
  type GenerationJobPage,
  GenerationJobPageSchema,
  type GenerationJobWorkspace,
  GenerationJobWorkspaceSchema,
} from '@bf/contracts';
import { Controller, Get, Param, ParseUUIDPipe, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { GenerationFiles } from '../../application/generation.files.ts';

class JobListQuery extends zodDto(GenerationJobListQuerySchema) {}

function orgOf(auth: AuthContext): string {
  if (!auth.orgId) throw new Error('Generation route reached without a workspace');
  return auth.orgId;
}

/** The workspace's jobs, and what a job was given and left (BF-046: review queue, console Brief/Artifacts tabs). */
@ApiTags('generation')
@Controller()
export class JobFilesController {
  constructor(private readonly files: GenerationFiles) {}

  @Get('generation-jobs')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'The workspace’s generation jobs, newest first (by status, by business)',
    operationId: 'listGenerationJobs',
    query: JobListQuery,
    response: { status: 200, schema: GenerationJobPageSchema },
    errors: [400, 401, 403],
  })
  list(@Ctx() auth: AuthContext, @Query() query: JobListQuery): Promise<GenerationJobPage> {
    return this.files.jobs(orgOf(auth), query as GenerationJobListQuery);
  }

  @Get('generation-jobs/:id/workspace')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'The brief, facts and assets the job’s engine was given (its latest workspace bundle)',
    operationId: 'getGenerationJobWorkspace',
    response: { status: 200, schema: GenerationJobWorkspaceSchema },
    errors: [401, 403, 404],
  })
  workspace(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GenerationJobWorkspace> {
    return this.files.workspace(orgOf(auth), id);
  }

  @Get('generation-jobs/:id/artifacts')
  @RequirePermission('sites:admin')
  @ApiRoute({
    summary: 'The job’s stored artifacts (bundles, site specs, screenshots, transcripts)',
    operationId: 'listGenerationJobArtifacts',
    response: { status: 200, schema: GenerationArtifactListSchema },
    errors: [401, 403, 404],
  })
  artifacts(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GenerationArtifactList> {
    return this.files.artifactList(orgOf(auth), id);
  }

  @Get('generation-jobs/:id/artifacts/:artifactId')
  @RequirePermission('sites:admin')
  @ApiProduces('application/octet-stream')
  @ApiRoute({
    summary: 'Download one of the job’s artifacts',
    operationId: 'downloadGenerationJobArtifact',
    response: { status: 200, schema: null },
    errors: [401, 403, 404],
  })
  async download(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('artifactId', ParseUUIDPipe) artifactId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.files.artifact(orgOf(auth), id, artifactId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new StreamableFile(file.body, {
      type: file.mediaType,
      length: file.body.length,
      disposition: `attachment; filename="${file.filename}"`,
    });
  }
}
