import { type RegistryFact, toSiteFactKind } from '@bf/contracts';
import type { Fact, FactRegistry } from '@bf/site-schema';

// The registry's display facts as a site's `facts.json` (BF-033 kinds and values): what a site may state, nothing
// internal. Kinds without a site counterpart stay out; structured values take the site's shapes.

const WEEKDAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** "mon 09:00–18:00; tue 09:00–12:00, 14:00–18:00" (the site fact of hours is text). */
export function hoursText(weekly: readonly { day: string; opens: string; closes: string }[]): string {
  const byDay = new Map<string, string[]>();
  for (const entry of weekly)
    byDay.set(entry.day, [...(byDay.get(entry.day) ?? []), `${entry.opens}–${entry.closes}`]);
  return WEEKDAY_ORDER.filter((day) => byDay.has(day))
    .map((day) => `${day} ${(byDay.get(day) ?? []).join(', ')}`)
    .join('; ');
}

export function toSiteFact(fact: RegistryFact): Fact | undefined {
  if (fact.usage !== 'display') return undefined;
  const kind = toSiteFactKind(fact.kind);
  if (!kind) return undefined;
  const base = {
    id: fact.id,
    ...(fact.locale && ['fr', 'en', 'nl', 'es', 'de'].includes(fact.locale)
      ? { locale: fact.locale as 'fr' | 'en' }
      : {}),
    source: fact.source,
    confidence: fact.confidence,
  };
  switch (fact.kind) {
    case 'price':
      return { ...base, kind: 'price', value: { amount: fact.value.amount, currency: fact.value.currency } };
    case 'year_founded':
      return fact.value >= 1000 ? { ...base, kind: 'year', value: fact.value } : undefined;
    case 'geo':
      return { ...base, kind: 'geo', value: fact.value };
    case 'testimonial':
      return {
        ...base,
        kind: 'testimonial',
        value: { quote: fact.value.quote, author: fact.value.attribution.slice(0, 60) },
      };
    case 'team_member':
      return {
        ...base,
        kind: 'team_member',
        value: { name: fact.value.name, ...(fact.value.role ? { role: fact.value.role } : {}) },
      };
    case 'hours':
      return { ...base, kind: 'hours', value: hoursText(fact.value.weekly) };
    case 'social':
      return { ...base, kind: 'social', value: fact.value.url };
    case 'booking_provider':
      return { ...base, kind: 'booking_url', value: fact.value.url };
    case 'menu_item':
      return { ...base, kind: 'menu_item', value: fact.value.name };
    default:
      return typeof fact.value === 'string' ? ({ ...base, kind, value: fact.value } as Fact) : undefined;
  }
}

/** `facts.json`: display facts only, unique ids. */
export function toSiteFactRegistry(facts: readonly RegistryFact[]): FactRegistry {
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const fact of facts) {
    const site = toSiteFact(fact);
    if (!site || seen.has(site.id)) continue;
    seen.add(site.id);
    out.push(site);
  }
  return { facts: out };
}
