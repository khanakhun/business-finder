import {
  type GenerationArtifact,
  type GenerationArtifactList,
  type GenerationJobListQuery,
  type GenerationJobPage,
  type GenerationJobWorkspace,
  NotFoundError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { toJob } from './generation.queries.ts';
import {
  type ArtifactStore,
  BUNDLE_UNPACKER,
  type BundleUnpacker,
  GENERATION_ARTIFACTS,
  GENERATION_REPOSITORY,
  type GenerationRepository,
  type StoredArtifact,
} from './ports.ts';

// What a job was given and what it left (BF-046, read side): the workspace's job list (the review queue, a business's
// Sites tab), a job's brief, facts and assets as written into its latest bundle (the console's Brief tab), and its
// stored artifacts (the Artifacts tab, `sites:admin`). Bundles are our own files; nothing here runs or renders them.

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const toArtifact = (artifact: StoredArtifact): GenerationArtifact => ({
  id: artifact.id,
  kind: artifact.kind as GenerationArtifact['kind'],
  attemptNo: artifact.attemptNo,
  sha256: artifact.sha256,
  bytes: artifact.bytes,
  createdAt: artifact.createdAt.toISOString(),
});

/** The keyset cursor: the last job's creation time and id. */
const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : undefined;
}

const MEDIA_TYPES: Record<string, string> = {
  workspace_bundle: 'application/zstd',
  site_spec: 'application/json',
  screenshot: 'image/png',
  transcript: 'application/x-ndjson',
  log_bundle: 'application/zstd',
};

@Injectable()
export class GenerationFiles {
  constructor(
    @Inject(GENERATION_REPOSITORY) private readonly repository: GenerationRepository,
    @Inject(GENERATION_ARTIFACTS) private readonly artifacts: ArtifactStore,
    @Inject(BUNDLE_UNPACKER) private readonly unpack: BundleUnpacker,
  ) {}

  async jobs(organizationId: string, query: GenerationJobListQuery): Promise<GenerationJobPage> {
    const after = decodeCursor(query.cursor);
    const rows = await this.repository.listJobs(organizationId, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.businessId ? { businessId: query.businessId } : {}),
      ...(after ? { after } : {}),
      limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toJob),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async workspace(organizationId: string, jobId: string): Promise<GenerationJobWorkspace> {
    await this.ownJob(organizationId, jobId);
    const bundle = (await this.repository.jobArtifacts(jobId)).find(
      (artifact) => artifact.kind === 'workspace_bundle',
    );
    const body = bundle ? await this.artifacts.get(bundle.storageKey) : undefined;
    if (!bundle || !body) throw new NotFoundError('GenerationWorkspace', jobId);
    const files = this.unpack(body);
    const json = (name: string): unknown => {
      const file = files.get(name);
      if (!file || file.length > MAX_FILE_BYTES) return undefined;
      try {
        return JSON.parse(file.toString('utf8'));
      } catch {
        return undefined;
      }
    };
    const brief = json('brief.json');
    const facts = (json('facts.json') as { facts?: unknown } | undefined)?.facts;
    const assets = (json('assets/assets.json') as { assets?: unknown } | undefined)?.assets;
    return {
      brief: brief && typeof brief === 'object' ? (brief as Record<string, unknown>) : {},
      facts: Array.isArray(facts) ? (facts as GenerationJobWorkspace['facts']) : [],
      assets: Array.isArray(assets) ? (assets as GenerationJobWorkspace['assets']) : [],
      bundle: {
        sha256: bundle.sha256,
        bytes: bundle.bytes,
        attemptNo: bundle.attemptNo,
        createdAt: bundle.createdAt.toISOString(),
      },
    };
  }

  async artifactList(organizationId: string, jobId: string): Promise<GenerationArtifactList> {
    await this.ownJob(organizationId, jobId);
    return { items: (await this.repository.jobArtifacts(jobId)).map(toArtifact) };
  }

  /** One artifact's bytes, its media type and a download name. */
  async artifact(organizationId: string, jobId: string, artifactId: string) {
    await this.ownJob(organizationId, jobId);
    const artifact = (await this.repository.jobArtifacts(jobId)).find(
      (candidate) => candidate.id === artifactId,
    );
    const body = artifact ? await this.artifacts.get(artifact.storageKey) : undefined;
    if (!artifact || !body) throw new NotFoundError('GenerationArtifact', artifactId);
    const extension = artifact.kind === 'site_spec' ? 'json' : artifact.kind === 'screenshot' ? 'png' : 'bin';
    return {
      body,
      mediaType: MEDIA_TYPES[artifact.kind] ?? 'application/octet-stream',
      filename: `${artifact.kind}-${artifact.attemptNo ?? 'job'}-${artifact.sha256.slice(0, 8)}.${extension}`,
    };
  }

  private async ownJob(organizationId: string, jobId: string) {
    const job = await this.repository.job(organizationId, jobId);
    if (!job) throw new NotFoundError('GenerationJob', jobId);
    return job;
  }
}
