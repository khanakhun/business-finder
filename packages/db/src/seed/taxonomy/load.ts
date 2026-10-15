import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CategoryAttributes,
  CategoryAttributesSchema,
  CategoryLabelsSchema,
  CategorySynonymsSchema,
  type OfferRelevance,
  OfferRelevanceSchema,
  type TaxonomyProvider,
  TaxonomyProviderSchema,
} from '@bf/contracts';
import { parse } from 'yaml';
import { z } from 'zod';

// Loads and validates the versioned taxonomy and provider mapping files (BF-015) — pure, no database.

export const TAXONOMY_DIR = fileURLToPath(new URL('../../../seed/taxonomy/', import.meta.url));

const SLUG = /^[a-z0-9_]{1,40}$/;
const MAX_DEPTH = 4;

interface NodeInput {
  slug: string;
  labels: { en: string; fr: string };
  synonyms?: { en: string[]; fr: string[] } | undefined;
  description?: string | undefined;
  icon?: string | undefined;
  attributes?: CategoryAttributes | undefined;
  offerRelevance?: OfferRelevance | undefined;
  children?: NodeInput[] | undefined;
}

const NodeSchema: z.ZodType<NodeInput> = z.strictObject({
  slug: z.string().regex(SLUG, 'slugs are lowercase snake_case, ≤ 40 characters'),
  labels: CategoryLabelsSchema,
  synonyms: CategorySynonymsSchema.optional(),
  description: z.string().min(1).optional(),
  icon: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  attributes: CategoryAttributesSchema.optional(),
  offerRelevance: OfferRelevanceSchema.optional(),
  get children() {
    return z.array(NodeSchema).optional();
  },
});

const TaxonomyFileSchema = z.strictObject({
  version: z.number().int().positive(),
  categories: z.array(NodeSchema).min(1),
});

const MappingFileSchema = z.strictObject({
  provider: TaxonomyProviderSchema,
  version: z.number().int().positive(),
  mappings: z.array(
    z.strictObject({
      key: z.string().min(1).max(200),
      label: z.string().min(1).optional(),
      category: z.string().regex(SLUG),
      confidence: z.number().min(0).max(1).default(0.95),
    }),
  ),
});

/** A category flattened from the tree, parents before children, with inherited values resolved. */
export interface TaxonomyCategory {
  readonly slug: string;
  readonly parentSlug: string | null;
  readonly path: string;
  readonly labels: { en: string; fr: string };
  readonly synonyms: { en: string[]; fr: string[] };
  readonly description: string | null;
  readonly icon: string | null;
  readonly attributes: CategoryAttributes;
  readonly offerRelevance: OfferRelevance;
  readonly sortOrder: number;
}

export interface TaxonomyMapping {
  readonly provider: TaxonomyProvider;
  readonly key: string;
  readonly label: string | null;
  readonly category: string;
  readonly confidence: number;
}

export interface Taxonomy {
  readonly version: number;
  readonly categories: readonly TaxonomyCategory[];
  readonly mappings: readonly TaxonomyMapping[];
}

export class TaxonomyFileError extends Error {
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'TaxonomyFileError';
  }
}

function validate<T>(schema: z.ZodType<T>, file: string, text: string): T {
  const result = schema.safeParse(parse(text));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 10);
    throw new TaxonomyFileError(file, issues.join('; '));
  }
  return result.data;
}

/** Flattens the tree: children inherit icon, attributes and offer relevance unless they set their own. */
export function flattenTaxonomy(file: string, roots: readonly NodeInput[]): TaxonomyCategory[] {
  const out: TaxonomyCategory[] = [];
  const seen = new Set<string>();
  const visit = (node: NodeInput, parent: TaxonomyCategory | null, depth: number, index: number) => {
    if (depth > MAX_DEPTH)
      throw new TaxonomyFileError(file, `${node.slug} is deeper than ${MAX_DEPTH} levels`);
    if (seen.has(node.slug)) throw new TaxonomyFileError(file, `duplicate slug ${node.slug}`);
    seen.add(node.slug);
    const category: TaxonomyCategory = {
      slug: node.slug,
      parentSlug: parent?.slug ?? null,
      path: parent ? `${parent.path}.${node.slug}` : node.slug,
      labels: { en: node.labels.en.trim(), fr: node.labels.fr.trim() },
      synonyms: { en: node.synonyms?.en ?? [], fr: node.synonyms?.fr ?? [] },
      description: node.description ?? null,
      icon: node.icon ?? parent?.icon ?? null,
      attributes: { ...parent?.attributes, ...node.attributes },
      offerRelevance: { ...parent?.offerRelevance, ...node.offerRelevance },
      sortOrder: index,
    };
    out.push(category);
    node.children?.forEach((child, i) => {
      visit(child, category, depth + 1, i);
    });
  };
  roots.forEach((root, i) => {
    visit(root, null, 1, i);
  });
  return out;
}

const versionOf = (name: string, prefix: string) => {
  const match = new RegExp(`^${prefix}\\.v(\\d+)\\.ya?ml$`).exec(name);
  return match ? Number(match[1]) : undefined;
};

/** Parses one taxonomy file and its mapping files (already read), checking every mapping targets a category. */
export function parseTaxonomy(
  taxonomyFile: { readonly name: string; readonly text: string },
  mappingFiles: ReadonlyArray<{ readonly name: string; readonly text: string }>,
): Taxonomy {
  const taxonomy = validate(TaxonomyFileSchema, taxonomyFile.name, taxonomyFile.text);
  const categories = flattenTaxonomy(taxonomyFile.name, taxonomy.categories);
  const slugs = new Set(categories.map((c) => c.slug));
  const mappings: TaxonomyMapping[] = [];
  const keys = new Set<string>();
  for (const file of mappingFiles) {
    const parsed = validate(MappingFileSchema, file.name, file.text);
    for (const mapping of parsed.mappings) {
      if (!slugs.has(mapping.category)) {
        throw new TaxonomyFileError(file.name, `${mapping.key} maps to unknown category ${mapping.category}`);
      }
      const id = `${parsed.provider}\u0000${mapping.key}`;
      if (keys.has(id)) throw new TaxonomyFileError(file.name, `duplicate key ${mapping.key}`);
      keys.add(id);
      mappings.push({
        provider: parsed.provider,
        key: mapping.key,
        label: mapping.label ?? null,
        category: mapping.category,
        confidence: mapping.confidence,
      });
    }
  }
  return { version: taxonomy.version, categories, mappings };
}

/** Reads the newest `taxonomy.v<N>.yaml` and, per provider, the newest `mappings/<provider>.v<N>.yaml`. */
export function loadTaxonomy(dir: string = TAXONOMY_DIR): Taxonomy {
  const newest = (folder: string, prefix: string) =>
    readdirSync(folder)
      .map((name) => ({ name, version: versionOf(name, prefix) }))
      .filter((f): f is { name: string; version: number } => f.version !== undefined)
      .sort((a, b) => b.version - a.version)[0];
  const taxonomy = newest(dir, 'taxonomy');
  if (!taxonomy) throw new TaxonomyFileError(dir, 'no taxonomy.v<N>.yaml');
  const mappingDir = join(dir, 'mappings');
  const mappingFiles = TaxonomyProviderSchema.options
    .map((provider) => newest(mappingDir, provider))
    .filter((f) => f !== undefined)
    .map((f) => ({ name: f.name, text: readFileSync(join(mappingDir, f.name), 'utf8') }));
  return parseTaxonomy(
    { name: taxonomy.name, text: readFileSync(join(dir, taxonomy.name), 'utf8') },
    mappingFiles,
  );
}
