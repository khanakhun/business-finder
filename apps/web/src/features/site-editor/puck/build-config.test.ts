import {
  BLOCK_SCHEMAS,
  BLOCK_TYPES,
  type BlockType,
  blockVariants,
  type SiteSpec,
  SiteSpecSchema,
} from '@bf/site-schema';
import cafe from '@bf/site-schema/fixtures/cafe-saint-jean.json' with { type: 'json' };
import hardware from '@bf/site-schema/fixtures/hardware-store-lorient.json' with { type: 'json' };
import salon from '@bf/site-schema/fixtures/salon-gustavia.json' with { type: 'json' };
import villa from '@bf/site-schema/fixtures/villa-agency.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import en from '../../../i18n/messages/en.json' with { type: 'json' };
import fr from '../../../i18n/messages/fr.json' with { type: 'json' };
import { buildPuckConfig, type ConfigLabels, summaryOf } from './build-config.tsx';
import { describeBlockFields, type FieldSpec } from './field-registry.ts';

const sites = [salon, cafe, hardware, villa].map((spec) => SiteSpecSchema.parse(spec) as SiteSpec);
const labels: ConfigLabels = {
  block: (type) => type,
  variant: (_type, variant) => variant,
  field: (key) => key,
  option: (_key, option) => option,
  variantField: 'Layout',
  blocks: 'Sections',
  yes: 'Yes',
  no: 'No',
  placeholder: () => 'New text',
  help: () => undefined,
};

describe('buildPuckConfig', () => {
  it.each(sites.map((spec) => [spec.brand.name, spec] as const))(
    'builds every block for %s',
    (_name, spec) => {
      const config = buildPuckConfig(spec, labels);
      expect(Object.keys(config.components).sort()).toEqual([...BLOCK_TYPES].sort());
      for (const type of BLOCK_TYPES) {
        const component = config.components[type];
        expect(Object.keys(component?.fields ?? {})).toEqual([
          'variant',
          ...Object.keys(BLOCK_SCHEMAS[type].shape.props.shape),
        ]);
      }
      // What is offered can be inserted as is: its default props are valid for the block.
      for (const type of (config.categories?.offered?.components ?? []) as BlockType[]) {
        const defaults = (config.components[type]?.defaultProps ?? {}) as Record<string, unknown>;
        const { variant, ...props } = defaults;
        expect(blockVariants(type)).toContain(variant);
        expect(BLOCK_SCHEMAS[type].shape.props.safeParse(props).success, type).toBe(true);
      }
      expect(config.categories?.offered?.components).not.toContain('testimonials');
    },
  );

  it('starts a new list item valid, never empty', () => {
    const config = buildPuckConfig(sites[0] as SiteSpec, labels);
    const items = config.components.highlights?.fields?.items as {
      defaultItemProps?: Record<string, unknown>;
    };
    expect(items.defaultItemProps).toMatchObject({ title: { fr: 'New text' }, icon: expect.any(String) });
  });

  it('does not offer a block whose site requirements are missing (booking without a booking page)', () => {
    const noBooking = { ...(sites[0] as SiteSpec), contact: { ...(sites[0] as SiteSpec).contact } };
    delete (noBooking.contact as { bookingUrl?: unknown }).bookingUrl;
    expect(buildPuckConfig(sites[0] as SiteSpec, labels).categories?.offered?.components).toContain(
      'booking',
    );
    expect(buildPuckConfig(noBooking, labels).categories?.offered?.components).not.toContain('booking');
  });
});

describe('summaryOf', () => {
  const fields = (
    describeBlockFields('highlights').find((field) => field.key === 'items') as FieldSpec & {
      kind: 'array';
    }
  ).item;
  it('summarizes a list item by its text, not its icon', () => {
    const item = fields.kind === 'object' ? fields.fields : [];
    expect(summaryOf({ icon: 'star', title: { fr: 'Ouvert 7j/7', en: 'Open daily' } }, item, 'en')).toBe(
      'Open daily',
    );
    expect(summaryOf({ icon: 'star' }, item, 'en')).toBeUndefined();
  });
});

describe('editor messages', () => {
  const keys = new Set<string>();
  const options = new Map<string, Set<string>>();
  const walk = (field: FieldSpec) => {
    keys.add(field.key);
    if (field.kind === 'enum') {
      const set = options.get(field.key) ?? new Set<string>();
      for (const option of field.options) set.add(option);
      options.set(field.key, set);
    }
    if (field.kind === 'object') field.fields.forEach(walk);
    if (field.kind === 'array') walk(field.item);
  };
  for (const type of BLOCK_TYPES) describeBlockFields(type).forEach(walk);

  it.each([
    ['en', en],
    ['fr', fr],
  ] as const)('names every block, layout, field and option in %s', (_lang, messages) => {
    const editor = messages.siteEditor as unknown as Record<string, Record<string, unknown>>;
    for (const type of BLOCK_TYPES) {
      expect(editor.blocks?.[type], type).toBeTruthy();
      for (const variant of blockVariants(type)) expect(editor.variants?.[variant], variant).toBeTruthy();
    }
    for (const key of [...keys, 'pageTitle', 'slug', 'seoTitle', 'seoDescription'])
      expect(editor.fieldNames?.[key], key).toBeTruthy();
    for (const [key, values] of options)
      for (const value of values)
        expect((editor.options?.[key] as Record<string, string>)?.[value], `${key}.${value}`).toBeTruthy();
  });
});
