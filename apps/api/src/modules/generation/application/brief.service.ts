import {
  type BriefOverrides,
  type GenerationBrief,
  type GenerationBriefPreview,
  type GenerationBriefQuery,
  NotFoundError,
  type RegistryFact,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { buildBrief } from '../domain/brief/build-brief.ts';
import type { PagePlanTemplate } from '../domain/brief/page-plan.ts';
import { BRIEF_SOURCES_READER, type BriefSources, type BriefSourcesReader } from './facts.ports.ts';
import { type FactActor, FactRegistryService } from './facts.service.ts';

// The generation brief of a business for a workspace (BF-040): the registry, the category, the audit, the review
// themes and the workspace's settings through the deterministic builder. The preview never spends money (no
// extraction); the workspace builder extracts the owner's pages before it builds the brief it ships.

export const PAGE_PLAN_TEMPLATES = Symbol('PAGE_PLAN_TEMPLATES');

@Injectable()
export class BriefService {
  constructor(
    private readonly registry: FactRegistryService,
    @Inject(BRIEF_SOURCES_READER) private readonly sources: BriefSourcesReader,
    @Inject(PAGE_PLAN_TEMPLATES) private readonly templates: readonly PagePlanTemplate[],
  ) {}

  /** The brief with the registry it rests on. */
  async build(
    actor: FactActor,
    businessId: string,
    options: {
      offer?: GenerationBriefQuery['offer'];
      overrides?: BriefOverrides;
      /** A pinned registry (the snapshot a generation reads); else the current one. */
      facts?: RegistryFact[];
      /** Image candidates the builder knows better than the crawl (the site's assets). */
      images?: { count: number; large: number };
    } = {},
  ): Promise<{ brief: GenerationBrief; facts: RegistryFact[]; sources: BriefSources }> {
    const facts = options.facts ?? (await this.registry.registry(actor, businessId)).facts;
    const sources = await this.sources.read(actor.organizationId, businessId);
    if (!sources) throw new NotFoundError('Business', businessId);
    const pagePlanId = options.overrides?.pagePlanId;
    if (pagePlanId && !this.templates.some((template) => template.id === pagePlanId))
      throw new NotFoundError('PagePlan', pagePlanId);
    const brief = buildBrief({
      businessId,
      facts,
      ...sources,
      ...(options.images ? { images: options.images } : {}),
      templates: this.templates,
      ...(options.offer ? { offer: options.offer } : {}),
      ...(options.overrides ? { overrides: options.overrides } : {}),
    });
    return { brief, facts, sources };
  }

  async preview(
    actor: FactActor,
    businessId: string,
    query: GenerationBriefQuery,
  ): Promise<GenerationBriefPreview> {
    const overrides: BriefOverrides = {
      ...(query.locales ? { locales: query.locales.split(',') } : {}),
      ...(query.style ? { style: query.style } : {}),
    };
    const { brief, facts } = await this.build(actor, businessId, {
      ...(query.offer ? { offer: query.offer } : {}),
      overrides,
    });
    const byKind: GenerationBriefPreview['registry']['byKind'] = {};
    for (const fact of facts) {
      const entry = byKind[fact.kind] ?? { display: 0, internal: 0 };
      entry[fact.usage] += 1;
      byKind[fact.kind] = entry;
    }
    return {
      brief,
      registry: {
        display: facts.filter((fact) => fact.usage === 'display').length,
        internal: facts.filter((fact) => fact.usage === 'internal').length,
        byKind,
      },
      pagePlans: this.templates.map((template) => ({ id: template.id, matched: [...template.match] })),
    };
  }
}
