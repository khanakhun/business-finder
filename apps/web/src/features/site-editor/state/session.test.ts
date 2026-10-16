import { type BaseOperation, MAX_BATCH, type SiteSpec, SiteSpecSchema } from '@bf/site-schema';
import salon from '@bf/site-schema/fixtures/salon-gustavia.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { applyInBatches, whereOf } from './session.ts';

const spec = SiteSpecSchema.parse(salon) as SiteSpec;
const labels = { block: (type: string) => `B:${type}`, field: (key: string) => `F:${key}`, page: 'Page' };

describe('applyInBatches', () => {
  it('applies more edits than one batch holds, in order', () => {
    const ops: BaseOperation[] = Array.from({ length: MAX_BATCH + 5 }, (_, n) => ({
      op: 'updateText',
      path: ['seo', 'title'],
      locale: 'en',
      value: `Title ${n}`,
    }));
    expect(applyInBatches(spec, ops).seo.title.en).toBe(`Title ${MAX_BATCH + 4}`);
    expect(applyInBatches(spec, [])).toBe(spec);
  });
});

describe('whereOf', () => {
  it('names the block and field, or the page setting, a path points at', () => {
    expect(whereOf(spec, ['pages', 0, 'blocks', 0, 'props', 'title', 'fr'], labels)).toBe('B:hero › F:title');
    expect(whereOf(spec, ['pages', 0, 'blocks', 2, 'props', 'items', 1, 'price', 'amount'], labels)).toBe(
      'B:services › F:items',
    );
    expect(whereOf(spec, ['pages', 0, 'seo', 'title', 'en'], labels)).toBe('Page › F:seoTitle');
    expect(whereOf(spec, ['pages', 0, 'title', 'fr'], labels)).toBe('Page › F:pageTitle');
    expect(whereOf(spec, ['theme', 'palette', 'text'], labels)).toBeUndefined();
    expect(whereOf(spec, ['pages', 9, 'title'], labels)).toBeUndefined();
  });
});
