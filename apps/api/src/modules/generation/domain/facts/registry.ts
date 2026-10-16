import type { FactSource, RegistryFact, RegistryFactKind } from '@bf/contracts';
import { bestSource, SINGLE_VALUED, usageFor } from './fact-usage.ts';

// Merging the observations of a business into its registry (BF-040): the same value seen from several sources is
// one fact carrying all its provenances (the best one speaks for it, any display-licensed one makes it displayable);
// the workspace's own facts then win over the global ones of single-valued kinds.

export interface Observation {
  readonly kind: RegistryFactKind;
  readonly value: unknown;
  readonly locale?: string;
  readonly source: FactSource;
  readonly sourceRef: string | null;
  readonly evidence?: string;
  readonly confidence: number;
  readonly observedAt: string;
}

/** The comparable form of a value (case, spacing and punctuation of phones and e-mails do not matter). */
export function normalizeValue(kind: RegistryFactKind, value: unknown): string {
  if (typeof value !== 'string')
    return JSON.stringify(value, Object.keys(value && typeof value === 'object' ? value : {}).sort());
  const text = value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (kind === 'phone' || kind === 'whatsapp') return text.replace(/[^\d+]/g, '');
  if (kind === 'website') return text.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  return text;
}

export function mergeObservations(
  observations: readonly Observation[],
  idFor: (kind: RegistryFactKind, value: unknown, sourceRef: string | null) => string,
): RegistryFact[] {
  const groups = new Map<string, Observation[]>();
  for (const observation of observations) {
    const key = `${observation.kind}\u0000${observation.locale ?? ''}\u0000${normalizeValue(observation.kind, observation.value)}`;
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  const facts: RegistryFact[] = [];
  for (const group of groups.values()) {
    const sources = group.map((observation) => observation.source);
    const best = bestSource(sources);
    const lead = group.find((observation) => observation.source === best) ?? group[0];
    if (!lead) continue;
    facts.push({
      id: idFor(lead.kind, lead.value, lead.sourceRef),
      kind: lead.kind,
      value: lead.value,
      ...(lead.locale ? { locale: lead.locale } : {}),
      source: best,
      sourceRef: lead.sourceRef,
      ...(lead.evidence ? { evidence: lead.evidence } : {}),
      confidence: Math.max(...group.map((observation) => observation.confidence)),
      observedAt:
        group
          .map((observation) => observation.observedAt)
          .sort()
          .at(-1) ?? lead.observedAt,
      usage: usageFor(lead.kind, sources),
    } as RegistryFact);
  }
  return facts.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

/** The workspace's facts on top: of a single-valued kind, they make the global ones internal. */
export function applyOverlay(
  global: readonly RegistryFact[],
  overlay: readonly RegistryFact[],
): RegistryFact[] {
  const overridden = new Set(overlay.filter((fact) => SINGLE_VALUED.has(fact.kind)).map((fact) => fact.kind));
  return [
    ...global.map((fact) =>
      overridden.has(fact.kind) ? ({ ...fact, usage: 'internal' } as RegistryFact) : fact,
    ),
    ...overlay,
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

/** Counts for the brief preview and the snapshot. */
export function registryStats(facts: readonly RegistryFact[]) {
  const byKind: Partial<Record<RegistryFactKind, number>> = {};
  for (const fact of facts) byKind[fact.kind] = (byKind[fact.kind] ?? 0) + 1;
  return {
    display: facts.filter((fact) => fact.usage === 'display').length,
    internal: facts.filter((fact) => fact.usage === 'internal').length,
    byKind,
  };
}
