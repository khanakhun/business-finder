import { randomBytes } from 'node:crypto';
import {
  type EmailLocale,
  type EmailTemplate,
  NotFoundError,
  type SaveEmailTemplateRequest,
  SaveEmailTemplateRequestSchema,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '../../../platform/db/transactional.ts';
import { AuditLogger } from '../../../workspace/index.ts';
import { lintTemplate } from '../../domain/drafting/template-lint.ts';
import { type StoredTemplate, TEMPLATE_REPOSITORY, type TemplateRepository } from './ports.ts';

// Email templates (BF-051): the workspace's own and the seeded library (EN/FR). A version is immutable; saving a
// seeded template creates the workspace's copy as its next version (same key), so the seed stays the default for
// other workspaces. Saving lints first: errors refuse the save, warnings are kept with the version.

export interface TemplateActor {
  readonly organizationId: string;
  readonly userId: string | null;
}

const toView = (row: StoredTemplate): EmailTemplate => ({
  id: row.id,
  key: row.key,
  name: row.name,
  purpose: row.purpose,
  offer: row.offer,
  locale: row.locale,
  version: row.version,
  subjectVariants: row.subjectVariants,
  bodyMd: row.bodyMd,
  variables: row.variables,
  status: row.status,
  seeded: row.seeded && row.organizationId === null,
  lint: row.lint,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

const slug = (name: string) =>
  `${name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40)}_${randomBytes(3).toString('hex')}`;

@Injectable()
export class TemplatesService {
  constructor(
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    private readonly audit: AuditLogger,
  ) {}

  /** The current version of each template (the workspace's copy wins over the seed); archived ones on request. */
  async list(actor: TemplateActor, includeArchived = false) {
    const rows = await this.templates.visible(actor.organizationId);
    const current = new Map<string, StoredTemplate>();
    for (const row of rows) {
      const slot = `${row.key}|${row.locale}`;
      const existing = current.get(slot);
      // Workspace rows beat seeds; then the highest version.
      const better =
        !existing ||
        (row.organizationId !== null && existing.organizationId === null) ||
        (row.organizationId === existing.organizationId && row.version > existing.version);
      if (better) current.set(slot, row);
    }
    const items = [...current.values()]
      .filter((row) => includeArchived || row.status === 'active')
      .sort((a, b) => a.purpose.localeCompare(b.purpose) || a.name.localeCompare(b.name))
      .map(toView);
    return { items };
  }

  async get(actor: TemplateActor, id: string) {
    return toView(await this.load(actor, id));
  }

  async versions(actor: TemplateActor, id: string) {
    const row = await this.load(actor, id);
    return { items: (await this.templates.versions(actor.organizationId, row.key, row.locale)).map(toView) };
  }

  lint(input: SaveEmailTemplateRequest) {
    const body = SaveEmailTemplateRequestSchema.parse(input);
    return lintTemplate({
      subjects: body.subjectVariants,
      body: body.bodyMd,
      purpose: body.purpose,
      locale: body.locale,
      template: true,
    });
  }

  @Transactional()
  async create(actor: TemplateActor, input: SaveEmailTemplateRequest) {
    const body = SaveEmailTemplateRequestSchema.parse(input);
    return toView(await this.save(actor, slug(body.name), 1, body));
  }

  /** A new version of a template (for a seed: the workspace's own copy). */
  @Transactional()
  async saveVersion(actor: TemplateActor, id: string, input: SaveEmailTemplateRequest) {
    const base = await this.load(actor, id);
    const body = SaveEmailTemplateRequestSchema.parse(input);
    if (body.locale !== base.locale)
      throw new ValidationError('A version keeps its template’s language.', [
        { path: ['locale'], message: 'Changed' },
      ]);
    const versions = await this.templates.versions(actor.organizationId, base.key, base.locale);
    const next = Math.max(0, ...versions.map((row) => row.version)) + 1;
    return toView(await this.save(actor, base.key, next, body));
  }

  @Transactional()
  async archive(actor: TemplateActor, id: string) {
    const row = await this.load(actor, id);
    if (row.organizationId === null) {
      // A seed is archived for this workspace by an archived copy.
      const versions = await this.templates.versions(actor.organizationId, row.key, row.locale);
      await this.templates.insert({
        ...row,
        organizationId: actor.organizationId,
        version: Math.max(...versions.map((v) => v.version)) + 1,
        status: 'archived',
        seeded: false,
        createdBy: actor.userId,
      });
    } else await this.templates.setStatus(actor.organizationId, id, 'archived');
    await this.audit.record({
      action: 'outreach.template_archived',
      entityType: 'email_template',
      entityId: id,
      metadata: {},
    });
  }

  /** The template a draft should use: the given one, else the workspace's current one for purpose/offer/locale. */
  async pick(
    actor: TemplateActor,
    input: {
      readonly templateId?: string | undefined;
      readonly purpose: string;
      readonly offer: string;
      readonly locale: EmailLocale;
      readonly hasPreview: boolean;
    },
  ): Promise<StoredTemplate | null> {
    if (input.templateId) return this.load(actor, input.templateId);
    const { items } = await this.list(actor);
    const candidates = items.filter((item) => item.purpose === input.purpose && item.locale === input.locale);
    const preferred =
      candidates.find(
        (item) => item.offer === input.offer && item.variables.includes('preview.url') === input.hasPreview,
      ) ??
      candidates.find((item) => item.variables.includes('preview.url') === input.hasPreview) ??
      candidates[0];
    return preferred ? this.load(actor, preferred.id) : null;
  }

  private async save(
    actor: TemplateActor,
    key: string,
    version: number,
    body: ReturnType<typeof SaveEmailTemplateRequestSchema.parse>,
  ) {
    const { issues, variables } = lintTemplate({
      subjects: body.subjectVariants,
      body: body.bodyMd,
      purpose: body.purpose,
      locale: body.locale,
      template: true,
    });
    const errors = issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0)
      throw new ValidationError(
        'The template has problems to fix first.',
        errors.map((issue) => ({ path: [issue.at ?? 'body'], message: issue.message })),
        { details: { reason: 'TEMPLATE_LINT', issues } },
      );
    const row = await this.templates.insert({
      organizationId: actor.organizationId,
      key,
      name: body.name,
      purpose: body.purpose,
      offer: body.offer,
      locale: body.locale,
      version,
      subjectVariants: body.subjectVariants,
      bodyMd: body.bodyMd,
      variables,
      status: 'active',
      seeded: false,
      lint: issues,
      createdBy: actor.userId,
    });
    await this.audit.record({
      action: 'outreach.template_saved',
      entityType: 'email_template',
      entityId: row.id,
      metadata: { key, version },
    });
    return row;
  }

  private async load(actor: TemplateActor, id: string): Promise<StoredTemplate> {
    const row = await this.templates.find(actor.organizationId, id);
    if (!row) throw new NotFoundError('EmailTemplate', id);
    return row;
  }
}
