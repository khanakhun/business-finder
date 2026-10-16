import { THEME_STYLES } from '@bf/site-schema';
import { coastal } from './coastal.ts';
import { luxe } from './luxe.ts';
import { minimal } from './minimal.ts';
import { modern } from './modern.ts';
import type { StyleFamily, StyleFamilyId } from './types.ts';
import { warm } from './warm.ts';

/** Every style family by id (one per `theme.style`). */
export const STYLE_FAMILIES: Readonly<Record<StyleFamilyId, StyleFamily>> = {
  luxe,
  modern,
  warm,
  minimal,
  coastal,
};

export const STYLE_FAMILY_IDS: readonly StyleFamilyId[] = THEME_STYLES;

export type { StyleFamily, StyleFamilyId } from './types.ts';
