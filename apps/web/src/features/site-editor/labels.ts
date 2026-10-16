'use client';

import type { BlockType } from '@bf/site-schema';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import type { ConfigLabels } from './puck/build-config.tsx';
import type { FieldSpec } from './puck/field-registry.ts';

/** The editor's words for blocks, layouts, fields and options (the messages, else a readable form of the key). */
export function useConfigLabels(): ConfigLabels {
  const t = useTranslations('siteEditor');
  return React.useMemo(() => {
    const humanize = (key: string) =>
      key
        .replace(/AssetIds?$|Id$/, '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .toLowerCase();
    const has = (key: string) => t.has(key as never);
    return {
      block: (type: BlockType) => (has(`blocks.${type}`) ? t(`blocks.${type}` as never) : type),
      variant: (_type: BlockType, variant: string) =>
        has(`variants.${variant}`) ? t(`variants.${variant}` as never) : humanize(variant),
      field: (key: string) => (has(`fieldNames.${key}`) ? t(`fieldNames.${key}` as never) : humanize(key)),
      option: (key: string, option: string) =>
        has(`options.${key}.${option}`) ? t(`options.${key}.${option}` as never) : humanize(option),
      variantField: t('variantField'),
      blocks: t('blocksTitle'),
      yes: t('yes'),
      no: t('no'),
      placeholder: (_field: FieldSpec) => t('newText'),
      help: (key: string) => (has(`help.${key}`) ? t(`help.${key}` as never) : undefined),
    };
  }, [t]);
}
