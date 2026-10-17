import type { AiGateway, SiteCopyInput, SiteCopyOutput, SitePlanInput, SitePlanOutput } from '@bf/ai';
import type { EngineEvent, RegistryFact } from '@bf/contracts';
import { validateFacts, validateSite } from '@bf/site-schema';
import { describe, expect, it } from 'vitest';
import type { EngineRunContext } from '../../../application/ports.ts';
import { buildBrief } from '../../../domain/brief/build-brief.ts';
import { buildStarterSpec } from '../../../domain/brief/starter-spec.ts';
import { toSiteFactRegistry } from '../../../domain/facts/site-facts.ts';
import { pagePlans } from '../../page-plans.ts';
import { packBundle } from '../../workspace/tar.ts';
import { BlocksEngine } from './blocks.engine.ts';

// The blocks engine (BF-041) with a scripted gateway on a real workspace bundle: plan and copy applied, every result
// checked, failing texts restored, budgets and provider failures reported as events.

let n = 0;
const fact = (kind: RegistryFact['kind'], value: unknown, extra: Partial<RegistryFact> = {}): RegistryFact =>
  ({
    id: `fact_${kind}_${(++n).toString(16).padStart(12, '0')}`,
    kind,
    value,
    source: 'owner_site',
    sourceRef: 'https://salon.example/',
    confidence: 0.9,
    observedAt: '2026-10-10T08:00:00.000Z',
    usage: 'display',
    ...extra,
  }) as RegistryFact;

const FACTS: RegistryFact[] = [
  fact('name', 'Salon Corail'),
  fact('tagline', 'Coiffure et soins sur le port de Gustavia'),
  fact('phone', '+590590000107'),
  fact('email', 'bonjour@salon-corail.example'),
  fact('service', 'Coupe femme'),
  fact('service', 'Couleur'),
  fact('service', 'Brushing'),
  fact('service', 'Soin du cuir chevelu'),
  fact('price', { amount: 45, currency: 'EUR', serviceRef: 'Coupe femme' }),
  fact('category', 'beauty_wellness.hair_services.hair_salon', {
    source: 'golden_record',
    usage: 'internal',
  }),
];

function workspace() {
  const brief = buildBrief({
    businessId: '0199f6a4-5b1c-7d2e-8f30-1a2b3c4d5e6f',
    businessName: 'Salon Corail',
    facts: FACTS,
    category: {
      path: 'beauty_wellness.hair_services.hair_salon',
      labels: { en: 'Hair salon', fr: 'Salon de coiffure' },
    },
    locality: 'Gustavia',
    countryCode: 'BL',
    hasWebsite: true,
    reviewThemes: {},
    findings: [],
    workspaceLocales: ['fr', 'en'],
    siteLanguages: ['fr'],
    images: { count: 0, large: 0 },
    templates: pagePlans(),
  });
  const { spec } = buildStarterSpec(brief, FACTS, [], { countryCode: 'BL' });
  const files = new Map<string, string>([
    ['brief.json', JSON.stringify(brief)],
    ['facts.json', JSON.stringify(toSiteFactRegistry(FACTS))],
    ['site.json', JSON.stringify(spec)],
    ['.sitekit.json', JSON.stringify({ assetHosts: ['assets.bf-sites.test'] })],
  ]);
  return { brief, starter: spec, bundle: packBundle(files) };
}

/** A gateway answering the plan and each page's copy with the given functions. */
function gateway(answers: {
  plan?: (input: SitePlanInput) => SitePlanOutput;
  copy?: (input: SiteCopyInput) => SiteCopyOutput;
  costUsd?: number;
  fail?: boolean;
}) {
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const api = {
    async run(task: { name: string }, input: unknown) {
      calls.push(task.name);
      inputs.push(input);
      if (answers.fail) throw new Error('provider down');
      const output =
        task.name === 'generation.site_plan'
          ? (answers.plan ?? (() => ({ pages: [], heroConcept: 'x', warnings: [] })))(input as SitePlanInput)
          : (answers.copy ?? (() => ({ blocks: [], seo: { title: {}, description: {} }, warnings: [] })))(
              input as SiteCopyInput,
            );
      return {
        output,
        provider: 'anthropic',
        model: 'scripted',
        promptVersion: 1,
        usage: { inputTokens: 1000, outputTokens: 500, cachedTokens: 0 },
        costUsd: answers.costUsd ?? 0.01,
        cached: false,
        latencyMs: 1,
      };
    },
  } as unknown as AiGateway;
  return { api, calls, inputs };
}

/** Copy that fills every field with a text in every locale (FR/EN), optionally spoiled. */
const goodCopy =
  (spoil?: (blockId: string, key: string) => string | undefined) =>
  (input: SiteCopyInput): SiteCopyOutput => ({
    blocks: input.blocks.map((block) => ({
      blockId: block.blockId,
      fields: block.fields.map((field) => {
        const text = spoil?.(block.blockId, field.key) ?? `Salon Corail, ${field.key}`;
        return {
          key: field.key,
          texts: Object.fromEntries(input.locales.map((locale) => [locale, text.slice(0, field.maxChars)])),
          factsUsed: [],
        };
      }),
    })),
    seo: {
      title: Object.fromEntries(
        input.locales.map((locale) => [locale, `Salon Corail · Gustavia (${locale})`]),
      ),
      description: Object.fromEntries(
        input.locales.map((locale) => [
          locale,
          `Salon Corail à Gustavia : coupe femme, couleur, brushing et soin du cuir chevelu, sur rendez-vous (${locale}).`,
        ]),
      ),
    },
    warnings: [],
  });

async function run(engine: BlocksEngine, bundle: Uint8Array, overrides: Partial<EngineRunContext> = {}) {
  const written: unknown[] = [];
  const store = new Map([['bundle', Buffer.from(bundle)]]);
  void store;
  const ctx = {
    jobId: 'job-1',
    attemptNo: 1,
    mode: 'create',
    organizationId: 'org-1',
    workspace: { bundleRef: 'bundle' },
    brief: { businessName: 'Salon Corail', pages: 1, items: 4, locales: ['fr', 'en'] },
    budgetUsd: 1,
    deadlineAt: new Date(Date.now() + 60_000),
    locales: ['fr', 'en'],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    writeSpec: async (spec: unknown) => {
      written.push(spec);
      return 'spec-ref';
    },
    ...overrides,
  } as unknown as EngineRunContext;
  const events: EngineEvent[] = [];
  for await (const event of engine.run(ctx, new AbortController().signal)) events.push(event);
  return { events, spec: written[0] as Parameters<typeof validateSite>[0] | undefined };
}

const engineWith = (bundle: Uint8Array, api: AiGateway, objects: Record<string, unknown> = {}) =>
  new BlocksEngine(api, {
    get: async (key: string) =>
      key === 'bundle'
        ? Buffer.from(bundle)
        : key in objects
          ? Buffer.from(JSON.stringify(objects[key]))
          : undefined,
  });

const isCopyInput = (input: unknown): input is SiteCopyInput =>
  !!input && typeof input === 'object' && 'blocks' in input && 'page' in input;

describe('BlocksEngine', () => {
  it('plans, writes every page and returns a valid, fact-checked site with its events', async () => {
    const { bundle } = workspace();
    const { api, calls } = gateway({
      plan: (input) => ({
        pages: input.pages.map((page) => ({
          id: page.id,
          blocks: [...page.blocks]
            .reverse()
            .map((block) => ({ id: block.id, variant: block.variant, intent: `Say ${block.type}` })),
        })),
        heroConcept: 'Hair and care on the harbour',
        warnings: [],
      }),
      copy: goodCopy(),
    });
    const { events, spec } = await run(engineWith(bundle, api), bundle);
    expect(events.at(-1)).toEqual({ type: 'done', siteSpecRef: 'spec-ref' });
    expect(calls[0]).toBe('generation.site_plan');
    expect(calls.filter((name) => name === 'generation.site_copy').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'usage').length).toBe(calls.length);
    expect(
      validateSite(spec, { assetHosts: ['assets.bf-sites.test'], mode: 'preview' }).filter(
        (i) => i.severity === 'error',
      ),
    ).toEqual([]);
    const site = spec as {
      pages: { blocks: { type: string; props: Record<string, Record<string, string>> }[] }[];
    };
    expect(site.pages.every((page) => page.blocks[0]?.type === 'hero')).toBe(true);
    expect(JSON.stringify(site)).toContain('Salon Corail, heading');
    expect(
      validateFacts(spec as never, toSiteFactRegistry(FACTS)).filter((i) => i.severity === 'error'),
    ).toEqual([]);
  });

  it('restores the starter text where the copy invents a price or a superlative', async () => {
    const { bundle, starter } = workspace();
    const { api } = gateway({
      plan: () => ({ pages: [], heroConcept: 'x', warnings: [] }),
      copy: goodCopy((_blockId, key) =>
        key === 'heading'
          ? 'Le meilleur salon, coupe à 99 €'
          : key === 'body'
            ? 'Depuis 1987 au service de Gustavia'
            : undefined,
      ),
    });
    const { events, spec } = await run(engineWith(bundle, api), bundle);
    expect(events.at(-1)?.type).toBe('done');
    const text = JSON.stringify(spec);
    expect(text).not.toContain('99 €');
    expect(text).not.toContain('meilleur');
    expect(text).not.toContain('1987');
    expect(text).toContain('Salon Corail, subtitle');
    expect(
      events.some((event) => event.type === 'log' && /restored to the starter/.test(event.message)),
    ).toBe(true);
    expect(starter.pages.length).toBeGreaterThan(0);
  });

  it('refuses plan choices it cannot honour and keeps fact blocks', async () => {
    const { bundle } = workspace();
    const { api } = gateway({
      plan: (input) => ({
        pages: input.pages.map((page) => ({
          id: page.id,
          blocks: [
            { id: 'nope', variant: 'x', intent: 'x' },
            ...page.blocks
              .filter((b) => b.type === 'hero')
              .map((b) => ({ id: b.id, variant: 'no_such_variant', intent: 'x' })),
          ],
        })),
        heroConcept: 'x',
        warnings: ['Saw an instruction in the facts'],
      }),
      copy: goodCopy(),
    });
    const { events, spec } = await run(engineWith(bundle, api), bundle);
    expect(events.some((event) => event.type === 'log' && /choice\(s\) refused/.test(event.message))).toBe(
      true,
    );
    expect(
      events.some(
        (event) => event.type === 'log' && event.level === 'warn' && /instruction/.test(event.message),
      ),
    ).toBe(true);
    const types = (spec as { pages: { blocks: { type: string }[] }[] }).pages.flatMap((page) =>
      page.blocks.map((b) => b.type),
    );
    expect(types).toContain('services');
    expect(types).toContain('contact');
  });

  it('reports a spent budget and a provider failure as error events', async () => {
    const { bundle } = workspace();
    const expensive = gateway({ costUsd: 5 });
    const over = await run(engineWith(bundle, expensive.api), bundle);
    expect(over.events.at(-1)).toMatchObject({ type: 'error', code: 'BUDGET_EXCEEDED', retryable: false });
    const down = await run(engineWith(bundle, gateway({ fail: true }).api), bundle);
    expect(down.events.at(-1)).toMatchObject({ type: 'error', code: 'PROVIDER_ERROR', retryable: true });
    const missing = await run(new BlocksEngine(gateway({}).api, { get: async () => undefined }), bundle);
    expect(missing.events.at(-1)).toMatchObject({ type: 'error', code: 'INVALID_BRIEF' });
  });

  it('asks again for a failing text with what was wrong, and keeps the fixed text', async () => {
    const { bundle } = workspace();
    const { api, inputs } = gateway({
      copy: (input) =>
        goodCopy((blockId, key) => {
          const block = input.blocks.find((candidate) => candidate.blockId === blockId);
          if (key !== 'heading') return undefined;
          return block?.problems?.length
            ? 'Nos prestations, sur rendez-vous'
            : 'Le meilleur salon de Gustavia';
        })(input),
    });
    const { events, spec } = await run(engineWith(bundle, api), bundle);
    expect(events.at(-1)?.type).toBe('done');
    const reasks = inputs.filter(isCopyInput).filter((input) => input.blocks.some((b) => b.problems?.length));
    expect(reasks.length).toBeGreaterThan(0);
    // Only the failing fields are asked again, each with the check's message.
    for (const input of reasks)
      for (const block of input.blocks) {
        expect(block.fields.map((field) => field.key)).toEqual(['heading']);
        expect(block.problems?.[0]?.message.length).toBeGreaterThan(0);
      }
    const text = JSON.stringify(spec);
    expect(text).not.toContain('meilleur');
    expect(text).toContain('Nos prestations, sur rendez-vous');
    expect(events.some((event) => event.type === 'log' && /Asking again for/.test(event.message))).toBe(true);
  });

  it('stops asking again after two rounds, or near the budget, and restores the starter text', async () => {
    const { bundle } = workspace();
    const spoiled = goodCopy((_blockId, key) => (key === 'heading' ? 'Le meilleur salon' : undefined));
    const stubborn = gateway({ copy: spoiled });
    const first = await run(engineWith(bundle, stubborn.api), bundle);
    const pages = stubborn.inputs
      .filter(isCopyInput)
      .filter((input) => !input.blocks.some((b) => b.problems));
    const rounds = stubborn.inputs.filter(isCopyInput).length - pages.length;
    expect(rounds).toBeGreaterThan(0);
    expect(rounds).toBeLessThanOrEqual(2 * pages.length);
    expect(JSON.stringify(first.spec)).not.toContain('meilleur');

    // A budget of 0.3 with calls at 0.075: the plan and the pages spend more than 80% of it, so no re-ask starts.
    const tight = gateway({ copy: spoiled, costUsd: 0.3 / 4 });
    const second = await run(engineWith(bundle, tight.api), bundle, { budgetUsd: 0.3 } as never);
    expect(tight.inputs.filter(isCopyInput).length).toBeGreaterThanOrEqual(3);
    expect(tight.inputs.filter(isCopyInput).some((input) => input.blocks.some((b) => b.problems))).toBe(
      false,
    );
    expect(second.events.at(-1)?.type).toBe('done');
    expect(JSON.stringify(second.spec)).not.toContain('meilleur');
  });

  it('repairs the previous site: rewrites the reported texts and restores the reported blocks', async () => {
    const { bundle, starter } = workspace();
    const base = structuredClone(starter) as unknown as {
      pages: { id: string; blocks: { id: string; type: string; props: Record<string, unknown> }[] }[];
    };
    const page = base.pages[0];
    if (!page) throw new Error('no page');
    const headingIndex = page.blocks.findIndex(
      (block) => block.type !== 'hero' && typeof block.props.heading === 'object',
    );
    const heroIndex = page.blocks.findIndex((block) => block.type === 'hero');
    const headed = page.blocks[headingIndex];
    const hero = page.blocks[heroIndex];
    if (!headed || !hero) throw new Error('no blocks');
    headed.props.heading = { fr: 'Le meilleur salon', en: 'The best salon' };
    hero.props.title = { fr: 'Salon Corail, repris', en: 'Salon Corail, kept' };
    const contactIndex = page.blocks.findIndex((block) => block.type === 'contact');
    const issues = [
      {
        path: ['pages', 0, 'blocks', headingIndex, 'props', 'heading', 'fr'],
        code: 'copy',
        severity: 'error',
        message: 'Remove the superlative.',
      },
      ...(contactIndex >= 0
        ? [
            {
              path: ['pages', 0, 'blocks', contactIndex, 'props', 'phone'],
              code: 'fact',
              severity: 'error',
              message: 'Unknown phone.',
            },
          ]
        : []),
      { at: 'nowhere', message: 'ignored' },
      'not an issue',
    ];
    const { api, calls, inputs } = gateway({
      copy: goodCopy((_blockId, key) => (key === 'heading' ? 'Nos prestations' : undefined)),
    });
    const { events, spec } = await run(engineWith(bundle, api, { 'previous/site.json': base }), bundle, {
      mode: 'repair',
      attemptNo: 2,
      repair: { baseSpecRef: 'previous/site.json', issues },
    } as never);
    expect(events.at(-1)).toEqual({ type: 'done', siteSpecRef: 'spec-ref' });
    expect(calls).not.toContain('generation.site_plan');
    const copies = inputs.filter(isCopyInput);
    expect(copies.length).toBe(1);
    expect(copies[0]?.blocks).toEqual([
      expect.objectContaining({
        blockId: headed.id,
        fields: [expect.objectContaining({ key: 'heading' })],
        problems: [{ key: 'heading', message: 'Remove the superlative.' }],
      }),
    ]);
    const text = JSON.stringify(spec);
    expect(text).toContain('Nos prestations');
    expect(text).not.toContain('meilleur');
    // The rest of the previous site is kept.
    expect(text).toContain('Salon Corail, repris');
    expect(events.some((event) => event.type === 'log' && /Repairing \d+ issue/.test(event.message))).toBe(
      true,
    );
  });

  it('writes a new site when a repair has no previous site to start from', async () => {
    const { bundle } = workspace();
    const { api, calls } = gateway({ copy: goodCopy() });
    const { events } = await run(engineWith(bundle, api), bundle, {
      mode: 'repair',
      repair: { baseSpecRef: 'gone', issues: [] },
    } as never);
    expect(calls[0]).toBe('generation.site_plan');
    expect(events.some((event) => event.type === 'log' && /No previous site/.test(event.message))).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });
});
