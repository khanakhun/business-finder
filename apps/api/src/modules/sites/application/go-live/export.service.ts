import type { ApiEnv } from '@bf/config';
import {
  type Clock,
  NotFoundError,
  newId,
  type RequestSiteExport,
  RequestSiteExportSchema,
  type SiteExport,
  type SiteExportStatus,
} from '@bf/contracts';
import { type SiteSpec, SiteSpecSchema } from '@bf/site-schema';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv } from '../../../platform/config/app-env.ts';
import { LOGGER, type Logger } from '../../../platform/logging/logger.ts';
import type { ObjectStorage } from '../../../platform/storage/object-storage.ts';
import { OBJECT_PRESIGNER, type ObjectPresigner } from '../../../platform/storage/s3-presigner.ts';
import { AuditLogger } from '../../../workspace/index.ts';
import { SITES_REPOSITORY, type SitesRepository } from '../ports.ts';
import type { SiteActor } from '../sites.commands.ts';

// The static export (BF-062): the agency takes a site as static files (a client leaving, an archive). A job renders
// the version, zips it into the artifacts bucket, and the list gives a signed link for 24 hours after it finished.

const LINK_TTL_MS = 24 * 3_600_000;
const LIST_LIMIT = 20;

export interface StaticExporter {
  export(spec: SiteSpec, signal?: AbortSignal): Promise<{ zip: Buffer; files: number }>;
}
export const STATIC_EXPORTER = Symbol('StaticExporter');
/** Where the zips go (the artifacts bucket). */
export const SITE_EXPORT_STORAGE = Symbol('SiteExportStorage');

export interface ExportRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly siteId: string;
  readonly versionId: string;
  readonly status: SiteExportStatus;
  readonly objectKey: string | null;
  readonly bytes: number | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

export interface ExportRepository {
  insert(record: {
    id: string;
    organizationId: string;
    siteId: string;
    versionId: string;
    requestedBy: string | null;
  }): Promise<void>;
  list(organizationId: string, siteId: string, limit: number): Promise<ExportRecord[]>;
  /** Moves a queued export to running; undefined when it is not queued (a duplicate job). */
  claim(id: string): Promise<ExportRecord | undefined>;
  finish(
    id: string,
    result: { status: 'succeeded' | 'failed'; objectKey?: string; bytes?: number; error?: string; at: Date },
  ): Promise<void>;
}
export const EXPORT_REPOSITORY = Symbol('ExportRepository');

export interface SiteExportQueue {
  enqueue(input: { organizationId: string; siteId: string; exportId: string }): Promise<void>;
}
export const SITE_EXPORT_QUEUE = Symbol('SiteExportQueue');

@Injectable()
export class SiteExportService {
  constructor(
    @Inject(EXPORT_REPOSITORY) private readonly repository: ExportRepository,
    @Inject(SITES_REPOSITORY) private readonly sites: SitesRepository,
    @Inject(SITE_EXPORT_QUEUE) private readonly queue: SiteExportQueue,
    @Inject(STATIC_EXPORTER) private readonly exporter: StaticExporter,
    @Inject(SITE_EXPORT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(OBJECT_PRESIGNER) private readonly presigner: ObjectPresigner,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly audit: AuditLogger,
  ) {}

  async request(actor: SiteActor, siteId: string, input: RequestSiteExport): Promise<SiteExport> {
    const request = RequestSiteExportSchema.parse(input);
    const site = await this.sites.site(actor.organizationId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    const versionId = request.versionId ?? site.currentVersionId;
    if (!versionId || !(await this.sites.version(siteId, versionId)))
      throw new NotFoundError('SiteVersion', versionId ?? 'current');
    const id = newId();
    await this.repository.insert({
      id,
      organizationId: actor.organizationId,
      siteId,
      versionId,
      requestedBy: actor.userId,
    });
    await this.queue.enqueue({ organizationId: actor.organizationId, siteId, exportId: id });
    await this.audit.record({
      action: 'sites.exported',
      organizationId: actor.organizationId,
      entityType: 'site',
      entityId: siteId,
      metadata: { exportId: id, versionId },
    });
    const [created] = await this.repository.list(actor.organizationId, siteId, 1);
    return this.toDto(created as ExportRecord);
  }

  async list(actor: SiteActor, siteId: string): Promise<SiteExport[]> {
    if (!(await this.sites.site(actor.organizationId, siteId))) throw new NotFoundError('Site', siteId);
    return Promise.all(
      (await this.repository.list(actor.organizationId, siteId, LIST_LIMIT)).map((record) =>
        this.toDto(record),
      ),
    );
  }

  /** The worker's side: render, zip, upload. A failure is recorded on the export (no retry: ask again). */
  async run(exportId: string, signal?: AbortSignal): Promise<SiteExportStatus | 'skipped'> {
    const record = await this.repository.claim(exportId);
    if (!record) return 'skipped';
    try {
      const version = await this.sites.version(record.siteId, record.versionId);
      if (!version) throw new Error('The version no longer exists.');
      const spec = SiteSpecSchema.parse(version.spec);
      const { zip, files } = await this.exporter.export(spec, signal);
      const objectKey = `exports/${record.organizationId}/${record.siteId}/${record.id}.zip`;
      await this.storage.put(objectKey, zip, 'application/zip');
      await this.repository.finish(record.id, {
        status: 'succeeded',
        objectKey,
        bytes: zip.byteLength,
        at: this.clock.now(),
      });
      this.logger.info({ exportId, files, bytes: zip.byteLength }, 'site exported');
      return 'succeeded';
    } catch (error) {
      this.logger.warn({ err: error, exportId }, 'site export failed');
      await this.repository.finish(record.id, {
        status: 'failed',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        at: this.clock.now(),
      });
      return 'failed';
    }
  }

  private async toDto(record: ExportRecord): Promise<SiteExport> {
    const expiresAt = record.finishedAt ? record.finishedAt.getTime() + LINK_TTL_MS : 0;
    const remaining = Math.floor((expiresAt - this.clock.now().getTime()) / 1_000);
    const downloadUrl =
      record.status === 'succeeded' && record.objectKey && remaining > 60
        ? await this.presigner.presignGet(
            (this.env as ApiEnv).S3_BUCKET_ARTIFACTS,
            record.objectKey,
            remaining,
          )
        : null;
    return {
      id: record.id,
      siteId: record.siteId,
      versionId: record.versionId,
      status: record.status,
      bytes: record.bytes,
      downloadUrl,
      error: record.error,
      createdAt: record.createdAt.toISOString(),
      finishedAt: record.finishedAt?.toISOString() ?? null,
    };
  }
}
