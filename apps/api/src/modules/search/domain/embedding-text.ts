// What a business's embedding is computed from (BF-022). Deterministic: the same facts always give the same text
// (and hash), so unchanged businesses are never re-embedded. Only global facts, never workspace data.

export interface EmbeddingCategory {
  readonly slug: string;
  readonly isPrimary: boolean;
  /** Labels from the root down to the category itself. */
  readonly labels: ReadonlyArray<{ readonly en: string; readonly fr: string }>;
}

export interface EmbeddingSource {
  readonly id: string;
  readonly displayName: string;
  readonly categories: readonly EmbeddingCategory[];
  readonly locality: string | null;
  readonly countryCode: string | null;
  /** Site intel summary (BF-026) once available. */
  readonly shortDescription: string | null;
  readonly priceLevel: number | null;
}

const PRICE = ['free', 'inexpensive', 'moderate', 'expensive', 'very expensive'] as const;
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Name, categories (EN / FR, primary first), place, description and price, one fact per line. */
export function composeEmbeddingText(source: EmbeddingSource): string {
  const categories = [...source.categories]
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.slug.localeCompare(b.slug))
    .map((c) => {
      const en = c.labels.map((l) => l.en).join(' > ');
      const fr = c.labels.map((l) => l.fr).join(' > ');
      return en === fr ? en : `${en} / ${fr}`;
    });
  const place = [source.locality, source.countryCode].filter(Boolean).join(', ');
  const price = source.priceLevel === null ? undefined : PRICE[source.priceLevel];
  return [
    clean(source.displayName),
    categories.length > 0 ? `Categories: ${categories.join('; ')}` : undefined,
    place ? `Location: ${clean(place)}` : undefined,
    source.shortDescription ? clean(source.shortDescription).slice(0, 1_000) : undefined,
    price ? `Price: ${price}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}
