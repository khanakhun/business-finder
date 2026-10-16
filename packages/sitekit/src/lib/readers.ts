import {
  type Asset,
  AssetSchema,
  BLOCK_SCHEMAS,
  type BlockType,
  blockMarkdown,
  CATALOG,
  type Fact,
  type FactRegistry,
} from '@bf/site-schema';
import { z } from 'zod';
import { parseFacts } from './validate.ts';
import type { Workspace } from './workspace.ts';

// The workspace readers (BF-042): the block catalog (markdown and JSON Schema), the facts a site may state and the
// images it may use.

export const FACTS_FILE = 'facts.json';
export const ASSETS_FILE = 'assets/assets.json';

export interface CatalogBlock {
  readonly type: BlockType;
  readonly title: string;
  readonly purpose: string;
  readonly variants: Readonly<Record<string, string>>;
  readonly markdown: string;
  readonly schema: unknown;
}

export class UnknownBlockError extends Error {
  constructor(readonly block: string) {
    super(`There is no block "${block}". Blocks: ${Object.keys(BLOCK_SCHEMAS).join(', ')}.`);
    this.name = 'UnknownBlockError';
  }
}

export function catalog(options: { block?: string } = {}): CatalogBlock[] {
  const types = Object.keys(BLOCK_SCHEMAS) as BlockType[];
  if (options.block && !types.includes(options.block as BlockType))
    throw new UnknownBlockError(options.block);
  return types
    .filter((type) => !options.block || type === options.block)
    .map((type) => {
      const entry = CATALOG[type];
      return {
        type,
        title: entry.title,
        purpose: entry.purpose,
        variants: entry.variants,
        markdown: blockMarkdown(type),
        schema: z.toJSONSchema(BLOCK_SCHEMAS[type], {
          target: 'draft-2020-12',
          io: 'input',
          unrepresentable: 'any',
        }),
      };
    });
}

export async function readFacts(workspace: Workspace): Promise<FactRegistry | undefined> {
  if (!(await workspace.exists(FACTS_FILE))) return undefined;
  return parseFacts(await workspace.readJson(FACTS_FILE));
}

/** Facts filtered by kind and/or a case-insensitive search over their values. */
export async function facts(
  workspace: Workspace,
  options: { kind?: string; search?: string } = {},
): Promise<Fact[]> {
  const registry = await readFacts(workspace);
  const needle = options.search?.toLowerCase();
  return (registry?.facts ?? []).filter(
    (fact) =>
      (!options.kind || fact.kind === options.kind) &&
      (!needle || JSON.stringify(fact.value).toLowerCase().includes(needle)),
  );
}

const AssetsFileSchema = z.object({ assets: z.array(AssetSchema) });

/** Images of the workspace; `role` is `logo` or `image` (photos). */
export async function assets(
  workspace: Workspace,
  options: { role?: 'logo' | 'image' } = {},
): Promise<Asset[]> {
  if (!(await workspace.exists(ASSETS_FILE))) return [];
  const parsed = AssetsFileSchema.parse(await workspace.readJson(ASSETS_FILE));
  return parsed.assets.filter((asset) => !options.role || asset.kind === options.role);
}
