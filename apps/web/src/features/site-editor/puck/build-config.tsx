'use client';

import {
  BLOCK_TYPES,
  type BlockType,
  blockVariants,
  type CtaAction,
  LIMITS,
  type LocalizedText,
  type SiteSpec,
} from '@bf/site-schema';
import type { ComponentConfig, Config, CustomField, Field, Fields } from '@puckeditor/core';
import type * as React from 'react';
import type { BlockItemProps, PageRootProps } from '../adapters/spec-to-puck.ts';
import { CanvasBlock, CanvasRoot } from './canvas.tsx';
import {
  defaultBlock,
  defaultItem,
  describeBlockFields,
  type FieldSpec,
  UnsupportedFieldError,
} from './field-registry.ts';
import {
  AssetField,
  AssetListField,
  CtaField,
  EnumListField,
  FactField,
  LocalizedTextField,
  PlainTextField,
  SlugField,
} from './fields.tsx';

/** The editor's words for the config (labels of blocks, variants, fields and options; placeholders). */
export interface ConfigLabels {
  readonly block: (type: BlockType) => string;
  readonly variant: (type: BlockType, variant: string) => string;
  readonly field: (key: string) => string;
  readonly option: (key: string, option: string) => string;
  readonly variantField: string;
  /** The drawer's heading. */
  readonly blocks: string;
  readonly yes: string;
  readonly no: string;
  /** A required text of a new block, in the site's default language. */
  readonly placeholder: (field: FieldSpec) => string;
}

const custom = <Value,>(label: string, render: CustomField<Value>['render']): CustomField<Value> => ({
  type: 'custom',
  label,
  render,
});

/**
 * An item's summary in a list: its first text in the site's language (a title, a question, a name), found in the
 * order of the item's fields; a plain value (an icon name) only when the item has no text.
 */
export function summaryOf(item: unknown, fields: readonly FieldSpec[], locale: string): string | undefined {
  if (item === null || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field.key];
    if ((field.kind === 'localizedText' || field.kind === 'richText') && value && typeof value === 'object') {
      const text = (value as Record<string, unknown>)[locale] ?? Object.values(value)[0];
      if (typeof text === 'string' && text) return text;
    }
  }
  for (const field of fields) {
    const value = record[field.key];
    if (field.kind === 'text' && typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** The Puck field of one schema field (a strategy per kind; `field-registry.ts` decides the kind). */
export function toPuckField(spec: FieldSpec, labels: ConfigLabels, site: SiteSpec): Field {
  const label = labels.field(spec.key);
  switch (spec.kind) {
    case 'localizedText':
    case 'richText':
      return custom<LocalizedText | undefined>(label, (props) => (
        <LocalizedTextField spec={spec} label={label} {...props} />
      ));
    case 'text':
      return custom<string | undefined>(label, (props) => (
        <PlainTextField max={spec.max} label={label} {...props} />
      ));
    case 'number':
      return {
        type: 'number',
        label,
        ...(spec.min !== undefined ? { min: spec.min } : {}),
        ...(spec.max !== undefined ? { max: spec.max } : {}),
        step: spec.integer ? 1 : 0.01,
      };
    case 'boolean':
      return {
        type: 'radio',
        label,
        options: [
          { label: labels.yes, value: true },
          { label: labels.no, value: false },
        ],
      };
    case 'enum':
      return {
        type: 'select',
        label,
        options: [
          ...(spec.optional ? [{ label: '—', value: undefined }] : []),
          ...spec.options.map((option) => ({ label: labels.option(spec.key, option), value: option })),
        ],
      };
    case 'asset':
      return custom<string | undefined>(label, (props) => (
        <AssetField label={label} optional={spec.optional} {...props} />
      ));
    case 'assets':
      return custom<readonly string[] | undefined>(label, (props) => (
        <AssetListField label={label} min={spec.min} max={spec.max} {...props} />
      ));
    case 'cta':
      return custom<CtaAction | undefined>(label, (props) => (
        <CtaField label={label} optional={spec.optional} {...props} />
      ));
    case 'fact':
    case 'facts':
      return custom<string | readonly string[] | undefined>(label, (props) => (
        <FactField label={label} {...props} />
      ));
    case 'object':
      return {
        type: 'object',
        label,
        objectFields: Object.fromEntries(
          spec.fields.map((field) => [field.key, toPuckField(field, labels, site)]),
        ),
      };
    case 'array': {
      const item = spec.item;
      if (item.kind === 'enum') {
        return custom<readonly string[] | undefined>(label, (props) => (
          <EnumListField
            label={label}
            options={item.options}
            optionLabel={(option) => labels.option(item.key, option)}
            {...props}
          />
        ));
      }
      if (item.kind !== 'object') {
        throw new UnsupportedFieldError(`No editor field for a list of ${item.kind} ("${spec.key}").`);
      }
      return {
        type: 'array',
        label,
        arrayFields: Object.fromEntries(
          item.fields.map((field) => [field.key, toPuckField(field, labels, site)]),
        ),
        ...(spec.min !== undefined ? { min: spec.min } : {}),
        ...(spec.max !== undefined ? { max: spec.max } : {}),
        getItemSummary: (entry: unknown, index?: number) =>
          summaryOf(entry, item.fields, site.defaultLocale) ??
          `${labels.field(spec.key)} ${(index ?? 0) + 1}`,
        // "Add item" starts from a valid item for this site (never `{}`, which the blocks cannot render).
        ...(() => {
          const fresh = defaultItem(spec, { spec: site, placeholder: labels.placeholder });
          return fresh === undefined ? {} : { defaultItemProps: fresh as Record<string, unknown> };
        })(),
      };
    }
  }
}

/**
 * The Puck config of a site (BF-037): one component per block type, its fields read from the BF-033 schema (a
 * variant select first), its default props filled for this site, and its render the block library's own component
 * (`CanvasBlock`), so the canvas is the published page. A block the site cannot fill (no image for one that needs
 * an image, a fact it lacks) is not offered.
 */
export function buildPuckConfig(site: SiteSpec, labels: ConfigLabels): Config {
  const components: Record<string, ComponentConfig> = {};
  const offered: BlockType[] = [];
  for (const type of BLOCK_TYPES) {
    const fields: Fields = {
      variant: {
        type: 'select',
        label: labels.variantField,
        options: blockVariants(type).map((variant) => ({
          label: labels.variant(type, variant),
          value: variant,
        })),
      },
    };
    for (const field of describeBlockFields(type)) fields[field.key] = toPuckField(field, labels, site);
    const defaults = defaultBlock(type, { spec: site, placeholder: labels.placeholder });
    if (defaults) offered.push(type);
    components[type] = {
      label: labels.block(type),
      fields,
      defaultProps: { ...(defaults?.props ?? {}), variant: defaults?.variant ?? blockVariants(type)[0] },
      render: (props) => <CanvasBlock type={type} props={props as unknown as BlockItemProps} />,
    };
  }
  const root: Config['root'] = {
    fields: {
      title: toPuckField(
        {
          key: 'pageTitle',
          kind: 'localizedText',
          max: LIMITS.pageTitle.max,
          multiline: false,
          optional: false,
          help: undefined,
        },
        labels,
        site,
      ),
      slug: custom<string | undefined>(labels.field('slug'), (props) => (
        <SlugField label={labels.field('slug')} {...props} />
      )),
      seoTitle: toPuckField(
        {
          key: 'seoTitle',
          kind: 'localizedText',
          max: LIMITS.seoTitle.max,
          multiline: false,
          optional: false,
          help: undefined,
        },
        labels,
        site,
      ),
      seoDescription: toPuckField(
        {
          key: 'seoDescription',
          kind: 'localizedText',
          max: LIMITS.seoDescription.max,
          multiline: true,
          optional: false,
          help: undefined,
        },
        labels,
        site,
      ),
    } satisfies Record<keyof PageRootProps, Field>,
    render: ({ children }: { children: React.ReactNode }) => <CanvasRoot>{children}</CanvasRoot>,
  };
  return {
    components,
    root,
    categories: {
      offered: { title: labels.blocks, components: offered, defaultExpanded: true },
      other: { visible: false },
    },
  };
}
