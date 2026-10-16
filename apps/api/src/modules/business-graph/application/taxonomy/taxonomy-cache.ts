import type { Clock } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { buildSynonymIndex, type SynonymIndex } from '../../domain/taxonomy/text-match.ts';
import {
  type CategoryRecord,
  type MappingRecord,
  TAXONOMY_REPOSITORY,
  type TaxonomyRepository,
} from './ports.ts';

/** The active taxonomy held in memory: ~300 categories and their mappings answer lookups in microseconds. */
export interface TaxonomySnapshot {
  readonly categories: readonly CategoryRecord[];
  readonly bySlug: ReadonlyMap<string, CategoryRecord>;
  readonly byId: ReadonlyMap<string, CategoryRecord>;
  /** `provider\u0000key` → active mapping. */
  readonly mappings: ReadonlyMap<string, MappingRecord>;
  readonly synonyms: SynonymIndex;
}

export const mappingKey = (provider: string, key: string) => `${provider}\u0000${key}`;

const TTL_MS = 60_000;

/** Read-through cache of the active taxonomy (60 s, or until a mapping review invalidates it in this process). */
@Injectable()
export class TaxonomyCache {
  private snapshot: { readonly value: Promise<TaxonomySnapshot>; readonly loadedAt: number } | undefined;

  constructor(
    @Inject(TAXONOMY_REPOSITORY) private readonly repository: TaxonomyRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  get(): Promise<TaxonomySnapshot> {
    const now = this.clock.now().getTime();
    if (!this.snapshot || now - this.snapshot.loadedAt > TTL_MS) {
      const value = this.load();
      // A failed load is not cached.
      value.catch(() => {
        if (this.snapshot?.value === value) this.snapshot = undefined;
      });
      this.snapshot = { value, loadedAt: now };
    }
    return this.snapshot.value;
  }

  invalidate(): void {
    this.snapshot = undefined;
  }

  private async load(): Promise<TaxonomySnapshot> {
    const { categories, mappings } = await this.repository.loadActive();
    return {
      categories,
      bySlug: new Map(categories.map((c) => [c.slug, c])),
      byId: new Map(categories.map((c) => [c.id, c])),
      mappings: new Map(mappings.map((m) => [mappingKey(m.provider, m.providerKey), m])),
      // Top-level groups ("Shops", "Restauration") are too broad to classify a business by name.
      synonyms: buildSynonymIndex(
        categories
          .filter((c) => c.path.includes('.'))
          .map((c) => ({
            slug: c.slug,
            phrases: [c.labels.en, c.labels.fr, ...c.synonyms.en, ...c.synonyms.fr],
          })),
      ),
    };
  }
}
