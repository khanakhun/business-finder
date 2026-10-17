import { type AiGateway, QualityUnsupportedClaims, type UnsupportedClaimsOutput } from '@bf/ai';
import type { QualityIssue } from '@bf/contracts';
import { parseSite } from '@bf/site-schema';
import { pathString, textFields } from '@bf/sitekit';
import { copyPaths } from '../../domain/blocks/compose.ts';
import { type GateOutcome, type QualityGate, targetOf } from './gates.ts';

// The claims gate (BF-045, AI, fast tier): the model lists the factual claims of the texts an engine wrote and
// whether the facts support them; the answer is checked — a "supported" claim citing a fact that is not in the job's
// registry is unsupported. Each unsupported claim is a repairable error on its block and locale. Fact values shown
// verbatim (names, quotes, prices) are the facts gate's, not sent here.

const MAX_TEXTS = 300;

/** A dotted path back to its segments (`pages[0].blocks[2].props.title.fr` → ['pages', 0, …]). */
export function pathSegments(path: string): (string | number)[] {
  return [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) =>
    match[2] !== undefined ? Number(match[2]) : (match[1] as string),
  );
}

export function claimsGate(gateway: AiGateway): QualityGate {
  return {
    id: 'claims',
    async run(ctx): Promise<GateOutcome> {
      const parsed = parseSite(ctx.spec);
      if (!parsed.spec) return { status: 'pass', costUsd: 0, issues: [] };
      const site = parsed.spec;
      const writable = copyPaths(site);
      const texts = textFields(site)
        .map((field) => ({ path: pathString(field.path), locale: field.locale, text: field.text.trim() }))
        .filter((field) => field.text && writable.some((path) => field.path.startsWith(`${path}.`)))
        .slice(0, MAX_TEXTS)
        .map((field) => ({ ...field, text: field.text.slice(0, 2000) }));
      if (texts.length === 0) return { status: 'pass', costUsd: 0, issues: [] };
      const facts = ctx.facts.facts.map((fact) => ({
        id: fact.id,
        kind: fact.kind,
        value: (typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value)).slice(0, 300),
      }));
      const result = await gateway.run(
        QualityUnsupportedClaims,
        {
          business: {
            name: (site.brand as { name?: string } | undefined)?.name?.slice(0, 200) ?? '',
            category: null,
          },
          facts: facts.slice(0, 150),
          texts,
        },
        { orgId: ctx.organizationId ?? null },
      );
      const answer = result.output as UnsupportedClaimsOutput;
      const known = new Set(facts.map((fact) => fact.id));
      const sent = new Set(texts.map((text) => text.path));
      const issues: QualityIssue[] = [];
      for (const claim of answer.claims) {
        if (!sent.has(claim.path)) continue;
        const invented =
          claim.status === 'supported' &&
          (claim.factIds.length === 0 || claim.factIds.some((id) => !known.has(id)));
        if (claim.status !== 'unsupported' && !invented) continue;
        issues.push({
          gate: 'claims',
          code: invented ? 'claim_fact_unknown' : 'claim_unsupported',
          severity: 'error',
          message: `Unsupported claim "${claim.quote.slice(0, 200)}": ${claim.reason.slice(0, 300)}`.slice(
            0,
            600,
          ),
          target: targetOf(ctx.spec, pathSegments(claim.path)),
          evidence: claim.quote.slice(0, 600),
          repairable: true,
          autoFixable: false,
          suggestedFix: 'Remove the claim or rephrase it as something facts.json states.',
        });
      }
      return {
        status: issues.length > 0 ? 'fail' : 'pass',
        costUsd: result.costUsd ?? 0,
        issues,
        model: result.model.slice(0, 80),
        promptVersion: result.promptVersion,
      };
    },
  };
}
