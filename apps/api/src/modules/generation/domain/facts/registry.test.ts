import type { RegistryFact, RegistryFactKind } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { bestSource, sourceOfProvider, usageFor } from './fact-usage.ts';
import {
  applyOverlay,
  mergeObservations,
  normalizeValue,
  type Observation,
  registryStats,
} from './registry.ts';

const at = '2026-10-16T12:00:00.000Z';
const idFor = (kind: RegistryFactKind, value: unknown, sourceRef: string | null) =>
  `fact_${kind}_${Buffer.from(`${JSON.stringify(value)}${sourceRef}`)
    .toString('hex')
    .slice(0, 12)
    .padEnd(12, '0')}`;

const seen = (
  overrides: Partial<Observation> & Pick<Observation, 'kind' | 'value' | 'source'>,
): Observation => ({
  sourceRef: 'https://cafe.example/contact',
  confidence: 0.8,
  observedAt: at,
  ...overrides,
});

describe('usage rules', () => {
  it('maps providers to the registry sources (restricted providers by default)', () => {
    expect(sourceOfProvider('website')).toBe('owner_site');
    expect(sourceOfProvider('osm')).toBe('open_data');
    expect(sourceOfProvider('overture')).toBe('open_data');
    expect(sourceOfProvider('manual')).toBe('user');
    expect(sourceOfProvider('import')).toBe('user');
    expect(sourceOfProvider('google_places')).toBe('provider_restricted');
    expect(sourceOfProvider('foursquare')).toBe('provider_restricted');
  });

  it('displays a fact with at least one display-licensed provenance, never one from restricted providers only', () => {
    expect(usageFor('phone', ['provider_restricted'])).toBe('internal');
    expect(usageFor('phone', ['provider_restricted', 'open_data'])).toBe('display');
    expect(usageFor('phone', ['golden_record'])).toBe('internal');
    expect(usageFor('phone', ['user'])).toBe('display');
  });

  it('takes testimonials only from the business’s own site', () => {
    expect(usageFor('testimonial', ['user'])).toBe('internal');
    expect(usageFor('testimonial', ['open_data'])).toBe('internal');
    expect(usageFor('testimonial', ['owner_site'])).toBe('display');
    expect(usageFor('testimonial', ['jsonld'])).toBe('display');
  });

  it('lets the best provenance speak for a fact', () => {
    expect(bestSource(['provider_restricted', 'open_data', 'owner_site'])).toBe('owner_site');
    expect(bestSource(['owner_site', 'user'])).toBe('user');
    expect(bestSource([])).toBe('provider_restricted');
  });
});

describe('normalizeValue', () => {
  it('ignores spacing and punctuation of phones, scheme and www of websites, and case', () => {
    expect(normalizeValue('phone', '+590 590 27 00 00')).toBe(normalizeValue('phone', '+590-590-270000'));
    expect(normalizeValue('website', 'https://www.Cafe.example/')).toBe(
      normalizeValue('website', 'cafe.example'),
    );
    expect(normalizeValue('name', '  Le  Café ')).toBe('le café');
    expect(normalizeValue('geo', { lng: 1, lat: 2 })).toBe(normalizeValue('geo', { lat: 2, lng: 1 }));
  });
});

describe('mergeObservations', () => {
  it('folds the same value from several sources into one fact that any licensed provenance makes displayable', () => {
    const facts = mergeObservations(
      [
        seen({
          kind: 'phone',
          value: '+590 590 27 00 00',
          source: 'provider_restricted',
          sourceRef: 'g:1',
          confidence: 0.9,
        }),
        seen({
          kind: 'phone',
          value: '+590590270000',
          source: 'open_data',
          sourceRef: 'osm:node/1',
          observedAt: '2026-10-17T00:00:00.000Z',
        }),
      ],
      idFor,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      kind: 'phone',
      value: '+590590270000',
      source: 'open_data',
      sourceRef: 'osm:node/1',
      confidence: 0.9,
      observedAt: '2026-10-17T00:00:00.000Z',
      usage: 'display',
    });
  });

  it('keeps distinct values and locales apart, and restricted-only facts internal', () => {
    const facts = mergeObservations(
      [
        seen({ kind: 'service', value: 'Brunch', source: 'owner_site', locale: 'en' }),
        seen({ kind: 'service', value: 'Brunch', source: 'owner_site', locale: 'fr' }),
        seen({
          kind: 'service',
          value: 'Dîner',
          source: 'owner_site',
          locale: 'fr',
          evidence: 'Dîner du mardi au samedi',
        }),
        seen({ kind: 'category', value: 'food_drink.cafe', source: 'provider_restricted' }),
      ],
      idFor,
    );
    expect(facts.map((fact) => [fact.kind, fact.locale, fact.usage])).toEqual([
      ['category', undefined, 'internal'],
      ['service', 'en', 'display'],
      ['service', 'fr', 'display'],
      ['service', 'fr', 'display'],
    ]);
    expect(facts.find((fact) => fact.value === 'Dîner')?.evidence).toBe('Dîner du mardi au samedi');
  });

  it('gives the same facts for the same observations in any order', () => {
    const observations = [
      seen({ kind: 'email', value: 'hello@cafe.example', source: 'owner_site' }),
      seen({ kind: 'name', value: 'Le Café', source: 'open_data' }),
      seen({ kind: 'phone', value: '+590590270000', source: 'owner_site' }),
    ];
    expect(mergeObservations([...observations].reverse(), idFor)).toEqual(
      mergeObservations(observations, idFor),
    );
  });
});

describe('applyOverlay', () => {
  const fact = (kind: RegistryFactKind, value: string, source: RegistryFact['source']): RegistryFact =>
    ({
      id: idFor(kind, value, source),
      kind,
      value,
      source,
      sourceRef: null,
      confidence: 1,
      observedAt: at,
      usage: 'display',
    }) as RegistryFact;

  it('makes the global facts of a single-valued kind internal when the workspace states one, keeping both', () => {
    const merged = applyOverlay(
      [fact('name', 'Cafe Old', 'open_data'), fact('service', 'Brunch', 'owner_site')],
      [fact('name', 'Le Café', 'user'), fact('service', 'Lunch', 'user')],
    );
    expect(merged.map((f) => [f.kind, f.value, f.usage])).toEqual(
      expect.arrayContaining([
        ['name', 'Cafe Old', 'internal'],
        ['name', 'Le Café', 'display'],
        ['service', 'Brunch', 'display'],
        ['service', 'Lunch', 'display'],
      ]),
    );
    expect(registryStats(merged)).toEqual({ display: 3, internal: 1, byKind: { name: 2, service: 2 } });
  });
});
