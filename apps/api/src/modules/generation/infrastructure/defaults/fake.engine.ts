import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { EngineCapabilities, EngineEvent } from '@bf/contracts';
import type { AgentEngine, EngineRunContext } from '../../application/ports.ts';

// The fake engine (BF-039; `GENERATION_FAKE_ENGINE`, refused in production): scripted events over a configurable
// time, a cost, and a fixture site personalised with the business's name. A business name can steer it in tests:
// `[fail:CODE]` fails every attempt with CODE (retryable unless fatal), `[fail-once:CODE]` fails the first attempt
// only, `[invalid]` writes a spec the validator refuses, `[slow]` runs ten times longer.

const fixtures = join(
  dirname(createRequire(import.meta.url).resolve('@bf/site-schema/package.json')),
  'fixtures',
);
const SALON = readFileSync(join(fixtures, 'salon-gustavia.json'), 'utf8');

export const FAKE_CAPABILITIES: EngineCapabilities = {
  sandboxed: true,
  supportsRepair: true,
  supportsChatEdit: false,
  maxParallel: 4,
  typicalCostUsd: 0.05,
  typicalDurationSec: 2,
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export class FakeEngine implements AgentEngine {
  readonly id = 'fake' as const;
  readonly capabilities: EngineCapabilities;

  constructor(
    private readonly options: {
      readonly durationMs: number;
      /** Our image CDN (the fixture's images are rewritten onto it so the result validates). */
      readonly assetsBaseUrl: string;
      readonly capabilities?: Partial<EngineCapabilities>;
    },
  ) {
    this.capabilities = { ...FAKE_CAPABILITIES, ...options.capabilities };
  }

  async available() {
    return true;
  }

  async *run(ctx: EngineRunContext, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const name = ctx.brief.businessName;
    const slow = name.includes('[slow]') ? 10 : 1;
    const step = Math.max(1, Math.round((this.options.durationMs * slow) / 4));
    yield { type: 'status', phase: 'running' };
    yield {
      type: 'log',
      level: 'info',
      message: `${ctx.mode === 'repair' ? 'Repairing' : 'Writing'} the site`,
    };
    await sleep(step, signal);
    yield { type: 'progress', pct: 25, label: 'Reading the brief' };
    yield { type: 'tool_call', tool: 'sitekit.catalog', summary: 'Listed the blocks' };
    await sleep(step, signal);
    yield {
      type: 'usage',
      inputTokens: 1200,
      outputTokens: 800,
      costUsd: this.capabilities.typicalCostUsd / 2,
    };
    yield { type: 'progress', pct: 60, label: 'Writing the pages' };
    await sleep(step, signal);
    const always = /\[fail:([A-Z_]+)\]/.exec(name)?.[1];
    const once = ctx.attemptNo === 1 ? /\[fail-once:([A-Z_]+)\]/.exec(name)?.[1] : undefined;
    const code = always ?? once;
    if (code) {
      yield {
        type: 'error',
        code,
        message: `Scripted failure ${code}`,
        retryable: code !== 'POLICY_VIOLATION',
      };
      return;
    }
    const spec = JSON.parse(SALON) as {
      brand: { name: string };
      assets: { url: string }[];
      seo: { title: Record<string, string> };
    };
    spec.brand.name =
      name
        .replace(/\[[^\]]*\]/g, '')
        .trim()
        .slice(0, 80) || 'Business';
    for (const asset of spec.assets)
      asset.url = asset.url.replace(/^https:\/\/[^/]+/, this.options.assetsBaseUrl);
    // An invalid result is fixed by a repair attempt (the validator refuses an empty search title).
    if (name.includes('[invalid]') && ctx.mode === 'create') spec.seo.title = { fr: '' } as never;
    const ref = await ctx.writeSpec(spec);
    yield { type: 'file_change', path: 'site.json' };
    yield {
      type: 'usage',
      inputTokens: 800,
      outputTokens: 1600,
      costUsd: this.capabilities.typicalCostUsd / 2,
    };
    yield { type: 'artifact', kind: 'site_spec', ref };
    await sleep(step, signal);
    yield { type: 'progress', pct: 100, label: 'Done' };
    yield { type: 'done', siteSpecRef: ref };
  }
}
