import type { AiGateway, UnsupportedClaimsInput, UnsupportedClaimsOutput } from '@bf/ai';
import { describe, expect, it } from 'vitest';
import type { StoredJob } from '../../application/ports.ts';
import { evalWorkspace, loadBusinesses } from '../engines/blocks/eval/harness.ts';
import { claimsGate, pathSegments } from './claims.gate.ts';
import { FullQualityPipeline } from './full-quality.pipeline.ts';

// The claims gate (BF-045) with a scripted model on a real workspace: only the texts an engine wrote are sent; an
// unsupported claim is a repairable error on its block and locale; a "supported" claim citing a fact the registry
// does not hold is unsupported; the call's model, prompt version and cost are recorded; through the pipeline, an
// unsupported claim sends the version to a repair.

const [business] = loadBusinesses();
if (!business) throw new Error('no eval business');
const workspace = evalWorkspace(business);
const job = { id: 'job-1', organizationId: 'org-1' } as StoredJob;
const factId = workspace.facts.find((fact) => fact.usage === 'display')?.id ?? '';

function gateway(answer: (input: UnsupportedClaimsInput) => UnsupportedClaimsOutput) {
  const inputs: UnsupportedClaimsInput[] = [];
  const api = {
    async run(_task: unknown, input: UnsupportedClaimsInput, context: { orgId: string | null }) {
      inputs.push(input);
      expect(context.orgId).toBe('org-1');
      return {
        output: answer(input),
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        promptVersion: 1,
        usage: { inputTokens: 3000, outputTokens: 400, cachedTokens: 0 },
        costUsd: 0.004,
        cached: false,
        latencyMs: 1,
      };
    },
  } as unknown as AiGateway;
  return { api, inputs };
}

const heroPath = (input: UnsupportedClaimsInput, suffix: string) =>
  input.texts.find(
    (text) =>
      /^pages\[0\]\.blocks\[0\]\.props\.(title|subtitle)\./.test(text.path) && text.path.endsWith(suffix),
  )?.path ?? '';

describe('claims gate', () => {
  it('flags unsupported claims and claims citing unknown facts, targeted, with the call recorded', async () => {
    const { api, inputs } = gateway((input) => ({
      claims: [
        {
          path: heroPath(input, '.fr'),
          quote: 'depuis 1985',
          status: 'unsupported',
          factIds: [],
          reason: 'No year fact.',
        },
        {
          path: heroPath(input, '.fr'),
          quote: 'élu meilleur salon',
          status: 'supported',
          factIds: ['fact_award_000000000000'],
          reason: 'Award.',
        },
        {
          path: heroPath(input, '.fr'),
          quote: workspace.brief.identity.name,
          status: 'supported',
          factIds: [factId],
          reason: 'Name.',
        },
        {
          path: 'pages[9].blocks[0].props.title.fr',
          quote: 'x',
          status: 'unsupported',
          factIds: [],
          reason: 'Not sent.',
        },
        {
          path: heroPath(input, '.fr'),
          quote: 'un accueil chaleureux',
          status: 'generic',
          factIds: [],
          reason: 'Marketing.',
        },
      ],
      warnings: [],
    }));
    const gate = claimsGate(api);
    const result = await gate.run({
      spec: workspace.starter,
      facts: { facts: workspace.facts.filter((fact) => fact.usage === 'display') } as never,
      config: {} as never,
      assetHosts: [],
      hotlinkHosts: [],
      thresholds: {} as never,
      organizationId: 'org-1',
    });
    // Only engine-written texts are sent (fact values verbatim are the facts gate's).
    expect(inputs[0]?.texts.every((text) => /\.(fr|en)$/.test(text.path))).toBe(true);
    expect(result).toMatchObject({
      status: 'fail',
      costUsd: 0.004,
      model: 'claude-haiku-5-5',
      promptVersion: 1,
    });
    expect(result.issues.map((issue) => issue.code)).toEqual(['claim_unsupported', 'claim_fact_unknown']);
    expect(result.issues[0]).toMatchObject({
      gate: 'claims',
      repairable: true,
      target: { pageId: 'home', locale: 'fr', blockId: workspace.starter.pages[0]?.blocks[0]?.id },
    });
  });

  it('sends an unsupported claim to a repair through the pipeline', async () => {
    const { api } = gateway((input) => ({
      claims: [
        {
          path: heroPath(input, '.fr'),
          quote: 'n°1 des Caraïbes',
          status: 'unsupported',
          factIds: [],
          reason: 'No ranking fact.',
        },
      ],
      warnings: [],
    }));
    const pipeline = new FullQualityPipeline({
      artifacts: { get: async () => Buffer.from(workspace.bundle) },
      repository: { artifactKey: async () => 'bundle' },
      assetHosts: ['assets.bf-sites.test'],
      gateway: api,
    });
    const result = await pipeline.evaluate({
      job,
      spec: workspace.starter,
      repairsLeft: 2,
      supportsRepair: true,
      attemptId: 'a1',
    });
    expect(result.outcome).toBe('repair');
    expect(result.report?.gates.map((gate) => gate.id).slice(0, 4)).toEqual([
      'schema',
      'facts',
      'claims',
      'copy',
    ]);
    expect(result.report?.issues[0]).toMatchObject({ gate: 'claims', code: 'claim_unsupported' });
    // A failing hard gate caps the score.
    expect(result.score).toBeLessThanOrEqual(40);
  });

  it('reads dotted paths back into segments', () => {
    expect(pathSegments('pages[0].blocks[12].props.title.fr')).toEqual([
      'pages',
      0,
      'blocks',
      12,
      'props',
      'title',
      'fr',
    ]);
    expect(pathSegments('seo.description.en')).toEqual(['seo', 'description', 'en']);
  });
});
