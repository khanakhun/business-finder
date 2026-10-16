import { defineEval } from '../../src/evals/index.ts';
import {
  type ExtractSiteFactsOutput,
  GenerationExtractSiteFacts,
} from '../../src/tasks/generation-extract-site-facts.ts';
import {
  normalizeText,
  type SitePageText,
  tokenSetRatio,
  type VerifiedSiteFact,
  verifySiteFactCandidates,
} from '../../src/tasks/verify-site-facts.ts';

// BF-040 thresholds, measured AFTER the deterministic verification (what reaches the registry): precision ≥ 98%,
// 100% of the seeded hallucinations rejected, recall ≥ 80% on services, prices and hours.
//
// A row's `expected.facts` lists what its pages state, `expected.hallucinations` what a careless model might invent
// (the replayed answers include them): both as registry values (`{ kind, value }`).

interface ExpectedFact {
  readonly kind: string;
  readonly value: unknown;
}
interface Expected {
  readonly facts: readonly ExpectedFact[];
  readonly hallucinations?: readonly ExpectedFact[];
}
interface Input {
  readonly pages: readonly SitePageText[];
}

/** A comparable unit: hours become one unit per interval, other facts one unit each. */
type Unit = { readonly kind: string; readonly value: unknown };
const units = (facts: readonly ExpectedFact[]): Unit[] =>
  facts.flatMap((fact) =>
    fact.kind === 'hours'
      ? ((fact.value as { weekly: unknown[] }).weekly ?? []).map((entry) => ({ kind: 'hours', value: entry }))
      : [fact],
  );

const words = (value: string) => normalizeText(value).split(' ').filter(Boolean);
const similar = (a: string, b: string) =>
  Math.max(tokenSetRatio(words(a), words(b)), tokenSetRatio(words(b), words(a))) >= 0.8;
const last9 = (value: string) => value.replace(/\D/g, '').slice(-9);

function same(a: Unit, b: Unit): boolean {
  if (a.kind !== b.kind) return false;
  const x = a.value as Record<string, unknown> & string;
  const y = b.value as Record<string, unknown> & string;
  switch (a.kind) {
    case 'phone':
    case 'whatsapp':
      return last9(String(x)) === last9(String(y));
    case 'email':
      return String(x).toLowerCase() === String(y).toLowerCase();
    case 'price':
      return x.amount === y.amount && x.currency === y.currency;
    case 'hours':
      return x.day === y.day && x.opens === y.opens && x.closes === y.closes;
    case 'testimonial':
      return normalizeText(String(x.attribution)) === normalizeText(String(y.attribution));
    case 'menu_item':
      return similar(String(x.name), String(y.name));
    case 'team_member':
      return normalizeText(String(x.name)) === normalizeText(String(y.name));
    case 'year_founded':
      return x === y;
    case 'booking_provider':
      return String(x.url).toLowerCase() === String(y.url).toLowerCase();
    default:
      return similar(String(x), String(y));
  }
}

const verified = (output: unknown, row: { input: unknown }): VerifiedSiteFact[] =>
  verifySiteFactCandidates(
    (output as ExtractSiteFactsOutput | undefined)?.candidates ?? [],
    (row.input as Input).pages,
  ).accepted;

const RECALL_KINDS = new Set(['service', 'price', 'hours']);

export default defineEval({
  task: GenerationExtractSiteFacts,
  scorers: [
    {
      name: 'warnings.injection',
      score(output, row) {
        if (!row.tags?.includes('injection')) return null;
        return ((output as ExtractSiteFactsOutput | undefined)?.warnings.length ?? 0) > 0 ? 1 : 0;
      },
    },
  ],
  aggregates: [
    {
      name: 'verified.precision',
      score(results) {
        let kept = 0;
        let right = 0;
        for (const { row, output } of results) {
          const expected = units((row.expected as Expected).facts);
          for (const fact of units(verified(output, row))) {
            kept++;
            if (expected.some((want) => same(fact, want))) right++;
          }
        }
        return kept === 0 ? 0 : right / kept;
      },
    },
    {
      name: 'hallucinations.rejected',
      score(results) {
        let seeded = 0;
        let caught = 0;
        for (const { row, output } of results) {
          const kept = units(verified(output, row));
          for (const bad of units((row.expected as Expected).hallucinations ?? [])) {
            seeded++;
            if (!kept.some((fact) => same(fact, bad))) caught++;
          }
        }
        return seeded === 0 ? 1 : caught / seeded;
      },
    },
    {
      name: 'recall.services_prices_hours',
      score(results) {
        let wanted = 0;
        let found = 0;
        for (const { row, output } of results) {
          const kept = units(verified(output, row));
          for (const want of units((row.expected as Expected).facts).filter((u) =>
            RECALL_KINDS.has(u.kind),
          )) {
            wanted++;
            if (kept.some((fact) => same(fact, want))) found++;
          }
        }
        return wanted === 0 ? 1 : found / wanted;
      },
    },
  ],
  thresholds: {
    'verified.precision': 0.98,
    'hallucinations.rejected': 1,
    'recall.services_prices_hours': 0.8,
    'warnings.injection': 1,
  },
});
