import { onColor, type Theme } from '@bf/site-schema';
import { fontStacks } from '../fonts/families.ts';
import { STYLE_FAMILIES, type StyleFamily } from './families/index.ts';

// Theme → CSS variables (BF-034). The stylesheet reads only `--bf-*` variables: the palette, the font pair, the
// theme's radius/density/image tokens and the style family's tokens. Values come from the validated theme (hex
// colours, enums) and the family data, never from free text, so they are safe in a style attribute.

export type CssVars = Readonly<Record<`--bf-${string}`, string>>;

const RADIUS: Record<Theme['radius'], { base: string; button: string; card: string }> = {
  none: { base: '0px', button: '0px', card: '0px' },
  sm: { base: '0.25rem', button: '0.25rem', card: '0.375rem' },
  md: { base: '0.5rem', button: '0.5rem', card: '0.75rem' },
  lg: { base: '0.875rem', button: '0.875rem', card: '1.25rem' },
  full: { base: '1rem', button: '9999px', card: '1.5rem' },
};

/** Section spacing per density (rem), before the family's rhythm factor. */
const SECTION_SPACE: Record<Theme['density'], number> = { compact: 3.75, comfortable: 5.25, airy: 6.75 };
const GAP: Record<Theme['density'], number> = { compact: 1.25, comfortable: 1.75, airy: 2.25 };

const rem = (value: number) => `${Number(value.toFixed(3))}rem`;

/** A style family's tokens as CSS variables. */
export function familyVars(family: StyleFamily): CssVars {
  const { type, border, shadow, button, image, layout } = family;
  return {
    '--bf-display': type.display,
    '--bf-h2': type.h2,
    '--bf-h3': type.h3,
    '--bf-heading-weight': String(type.headingWeight),
    '--bf-heading-tracking': type.headingTracking,
    '--bf-heading-leading': String(type.headingLeading),
    '--bf-heading-case': type.headingCase,
    '--bf-body': type.body,
    '--bf-body-leading': String(type.bodyLeading),
    '--bf-lead': type.lead,
    '--bf-eyebrow-size': type.eyebrowSize,
    '--bf-eyebrow-tracking': type.eyebrowTracking,
    '--bf-eyebrow-case': type.eyebrowCase,
    '--bf-eyebrow-weight': String(type.eyebrowWeight),
    '--bf-border-width': border.width,
    '--bf-shadow-card': shadow.card,
    '--bf-shadow-raised': shadow.raised,
    '--bf-btn-weight': String(button.weight),
    '--bf-btn-tracking': button.tracking,
    '--bf-btn-case': button.case,
    '--bf-btn-size': button.size,
    '--bf-btn-padding': button.padding,
    '--bf-image-filter': image.filter,
    '--bf-overlay': String(image.overlay),
    '--bf-max-width': layout.maxWidth,
    '--bf-measure': layout.measure,
  };
}

/** A #rrggbb colour, else the fallback (the schema checks colours; this keeps a style attribute safe regardless). */
const color = (value: string | undefined, fallback: string) =>
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

/** Every CSS variable a site's theme sets (palette, fonts, tokens and its style family). */
export function themeToCssVars(theme: Theme): CssVars {
  const family = STYLE_FAMILIES[theme.style] ?? STYLE_FAMILIES.modern;
  const palette = {
    primary: color(theme.palette.primary, '#1f2937'),
    secondary: theme.palette.secondary === undefined ? undefined : color(theme.palette.secondary, '#1f2937'),
    accent: color(theme.palette.accent, '#1f2937'),
    background: color(theme.palette.background, '#ffffff'),
    surface: color(theme.palette.surface, '#f5f5f5'),
    text: color(theme.palette.text, '#111111'),
    mutedText: color(theme.palette.mutedText, '#4b5563'),
  };
  const fonts = fontStacks(theme.typography.pairId);
  const radius = RADIUS[theme.radius] ?? RADIUS.md;
  const imageRadius = theme.imageTreatment === 'plain' ? '0px' : radius.card;
  return {
    '--bf-primary': palette.primary,
    '--bf-on-primary': onColor(palette.primary),
    '--bf-secondary': palette.secondary ?? palette.primary,
    '--bf-accent': palette.accent,
    '--bf-bg': palette.background,
    '--bf-surface': palette.surface,
    '--bf-text': palette.text,
    '--bf-muted': palette.mutedText,
    '--bf-font-heading': fonts.heading,
    '--bf-font-body': fonts.body,
    '--bf-radius': radius.base,
    '--bf-radius-button': radius.button,
    '--bf-radius-card': radius.card,
    '--bf-radius-image': imageRadius,
    '--bf-section-space': rem((SECTION_SPACE[theme.density] ?? SECTION_SPACE.comfortable) * family.rhythm),
    '--bf-gap': rem(GAP[theme.density] ?? GAP.comfortable),
    ...familyVars(family),
  };
}

/**
 * Data attributes for the structural choices of the family and theme (the stylesheet styles cards, section
 * alternation, ornaments, buttons and image frames by them).
 */
export function themeDataAttributes(theme: Theme): Readonly<Record<`data-${string}`, string>> {
  const family = STYLE_FAMILIES[theme.style] ?? STYLE_FAMILIES.modern;
  return {
    'data-style': family.id,
    'data-cards': family.border.cards,
    'data-alternate': family.section.alternate,
    'data-ornament': family.section.ornament,
    'data-heading-align': family.section.headingAlign,
    'data-secondary-button': family.button.secondary,
    'data-overlay': family.image.overlayShape,
    'data-image': ['plain', 'rounded', 'framed'].includes(theme.imageTreatment)
      ? theme.imageTreatment
      : 'plain',
  };
}

/** The variables as a CSS declaration list (for a `style` attribute or a rule). */
export const cssVarsText = (vars: CssVars) =>
  Object.entries(vars)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
