import { contrastRatio, THEME_STYLES } from '@bf/site-schema';
import { describe, expect, it } from 'vitest';
import { fixture } from '../test-utils.tsx';
import { STYLE_FAMILIES } from './families/index.ts';
import { cssVarsText, familyVars, themeDataAttributes, themeToCssVars } from './theme-vars.ts';

const salon = fixture('salon-gustavia');

describe('themeToCssVars', () => {
  it('maps the palette, the font pair and the tokens', () => {
    const vars = themeToCssVars(salon.theme);
    expect(vars['--bf-primary']).toBe(salon.theme.palette.primary);
    expect(vars['--bf-bg']).toBe(salon.theme.palette.background);
    expect(vars['--bf-font-heading']).toMatch(/^"Cormorant Garamond", Georgia/);
    expect(vars['--bf-font-body']).toMatch(/^"Montserrat", system-ui/);
    expect(vars['--bf-radius-button']).toBe('0.25rem');
  });

  it('puts readable text on the primary colour (black or white, whichever contrasts more)', () => {
    for (const primary of ['#0b3954', '#f5d547', '#7a5c3e', '#ffffff']) {
      const vars = themeToCssVars({ ...salon.theme, palette: { ...salon.theme.palette, primary } });
      const other = vars['--bf-on-primary'] === '#000000' ? '#ffffff' : '#000000';
      expect(contrastRatio(vars['--bf-on-primary'] ?? '', primary)).toBeGreaterThanOrEqual(
        contrastRatio(other, primary),
      );
    }
  });

  it('falls back to the primary colour without a secondary one, and squares plain images', () => {
    const vars = themeToCssVars({ ...salon.theme, imageTreatment: 'plain', radius: 'full' });
    expect(vars['--bf-secondary']).toBe(salon.theme.palette.secondary ?? salon.theme.palette.primary);
    expect(vars['--bf-radius-image']).toBe('0px');
    expect(vars['--bf-radius-button']).toBe('9999px');
  });

  it('scales section spacing by density and the family rhythm', () => {
    const space = (style: (typeof THEME_STYLES)[number], density: 'compact' | 'airy') =>
      Number.parseFloat(themeToCssVars({ ...salon.theme, style, density })['--bf-section-space'] ?? '');
    for (const style of THEME_STYLES) expect(space(style, 'airy')).toBeGreaterThan(space(style, 'compact'));
    expect(space('luxe', 'airy')).toBeGreaterThan(space('modern', 'airy'));
  });

  it('gives every style family the same set of variables and data attributes', () => {
    const names = (style: (typeof THEME_STYLES)[number]) =>
      Object.keys(themeToCssVars({ ...salon.theme, style }));
    for (const style of THEME_STYLES) {
      expect(names(style)).toEqual(names('luxe'));
      expect(Object.keys(themeDataAttributes({ ...salon.theme, style }))).toHaveLength(8);
      expect(STYLE_FAMILIES[style].id).toBe(style);
    }
  });

  it('writes the variables as declarations (no braces or semicolons inside a value)', () => {
    for (const style of THEME_STYLES) {
      for (const value of Object.values(familyVars(STYLE_FAMILIES[style])))
        expect(value).not.toMatch(/[{};<>]/);
    }
    expect(cssVarsText({ '--bf-a': '1', '--bf-b': 'x y' })).toBe('--bf-a:1;--bf-b:x y');
  });
});
