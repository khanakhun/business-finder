import { BLOCK_SCHEMAS, BLOCK_TYPES, type SiteSpec, SiteSpecSchema } from '@bf/site-schema';
import cafe from '@bf/site-schema/fixtures/cafe-saint-jean.json' with { type: 'json' };
import salon from '@bf/site-schema/fixtures/salon-gustavia.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defaultBlockProps,
  describeBlockFields,
  describeField,
  type FieldSpec,
  UnsupportedFieldError,
} from './field-registry.ts';

const kinds = (fields: readonly FieldSpec[]): string[] =>
  fields.flatMap((field) => [
    field.kind,
    ...(field.kind === 'object' ? kinds(field.fields) : field.kind === 'array' ? kinds([field.item]) : []),
  ]);

describe('describeBlockFields', () => {
  it.each(BLOCK_TYPES)('describes every prop of %s', (type) => {
    const fields = describeBlockFields(type);
    expect(fields.map((field) => field.key)).toEqual(Object.keys(BLOCK_SCHEMAS[type].shape.props.shape));
  });

  it('reads the meaning of shared schemas, limits and bounds', () => {
    const hero = Object.fromEntries(describeBlockFields('hero').map((field) => [field.key, field]));
    expect(hero.title).toMatchObject({ kind: 'localizedText', max: 60, optional: false });
    expect(hero.subtitle).toMatchObject({ kind: 'localizedText', optional: true });
    expect(hero.primaryCta).toMatchObject({ kind: 'cta', optional: true });
    expect(hero.imageAssetId).toMatchObject({ kind: 'asset' });
    const gallery = describeBlockFields('gallery').find((field) => field.key === 'assetIds');
    expect(gallery).toMatchObject({ kind: 'assets', min: 3, max: 12 });
    expect(describeBlockFields('rich_text').find((field) => field.key === 'body')).toMatchObject({
      kind: 'richText',
    });
    const testimonials = describeBlockFields('testimonials').find((field) => field.key === 'items');
    expect(testimonials?.kind === 'array' && kinds([testimonials.item])).toEqual(
      expect.arrayContaining(['fact', 'localizedText', 'text', 'enum', 'number']),
    );
  });

  it('refuses a schema kind it has no field for (a new block cannot ship without editor support)', () => {
    expect(() => describeField('when', z.date(), 'hero')).toThrow(UnsupportedFieldError);
    expect(() => describeField('either', z.union([z.string(), z.number()]), 'hero')).toThrow(
      UnsupportedFieldError,
    );
  });
});

describe('defaultBlockProps', () => {
  const sites = [SiteSpecSchema.parse(salon), SiteSpecSchema.parse(cafe)];
  const ctx = (spec: SiteSpec) => ({ spec, placeholder: () => 'New text' });

  it.each(BLOCK_TYPES)('gives %s schema-valid props, or nothing when the site cannot fill them', (type) => {
    for (const spec of sites) {
      const props = defaultBlockProps(type, ctx(spec));
      if (props === undefined) continue;
      expect(BLOCK_SCHEMAS[type].shape.props.safeParse(props).error?.issues ?? []).toEqual([]);
    }
  });

  it('never invents a fact, and needs an image for a block that shows one', () => {
    expect(defaultBlockProps('testimonials', ctx(sites[0] as SiteSpec))).toBeUndefined();
    const noImages = { ...(sites[0] as SiteSpec), assets: [] };
    expect(defaultBlockProps('gallery', ctx(noImages))).toBeUndefined();
    expect(defaultBlockProps('faq', ctx(noImages))).toBeDefined();
  });
});
