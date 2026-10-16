import type { Block, BlockType } from '@bf/site-schema';
import { BLOCK_COMPONENTS } from './registry.ts';
import type { BlockComponent, RenderContext } from './types.ts';

/** A block of a type this library does not know (a newer spec, or a broken one). */
export class UnknownBlockError extends Error {
  constructor(readonly blockType: string) {
    super(`Unknown block type "${blockType}": add it to the block registry.`);
    this.name = 'UnknownBlockError';
  }
}

/**
 * Renders one block by its type. An unknown type throws in development and is skipped with a logged error in
 * production (the page still renders).
 */
export function BlockRenderer({
  block,
  ctx,
  index,
  tone,
}: {
  block: Block;
  ctx: RenderContext;
  index: number;
  tone?: 'base' | 'alt' | undefined;
}) {
  const Component = (BLOCK_COMPONENTS as Partial<Record<string, BlockComponent<BlockType>>>)[block.type];
  if (!Component) {
    if (ctx.options.mode === 'development') throw new UnknownBlockError(block.type);
    (ctx.options.logger ?? console).error('site-blocks: unknown block type skipped', {
      blockType: block.type,
      blockId: block.id,
      pageId: ctx.page.id,
    });
    return null;
  }
  return <Component block={block as never} ctx={ctx} index={index} tone={tone} />;
}

/** The tone of each block: the hero has none, then the others alternate (the family decides what it looks like). */
export function blockTones(blocks: readonly Block[]): ('base' | 'alt' | undefined)[] {
  let n = 0;
  return blocks.map((block) => {
    if (block.type === 'hero') return undefined;
    n += 1;
    return n % 2 === 1 ? 'alt' : 'base';
  });
}
