import type { StyleFamily } from './types.ts';

/** Refined and editorial: light serif display, wide letter-spaced labels, generous space, thin rules, no shadows. */
export const luxe: StyleFamily = {
  id: 'luxe',
  type: {
    display: 'clamp(2.6rem, 1.6rem + 4.6vw, 5rem)',
    h2: 'clamp(1.9rem, 1.4rem + 2vw, 3rem)',
    h3: '1.375rem',
    headingWeight: 400,
    headingTracking: '-0.005em',
    headingLeading: 1.08,
    headingCase: 'none',
    body: '1.0625rem',
    bodyLeading: 1.75,
    lead: 'clamp(1.125rem, 1rem + 0.4vw, 1.3rem)',
    eyebrowSize: '0.75rem',
    eyebrowTracking: '0.28em',
    eyebrowCase: 'uppercase',
    eyebrowWeight: 500,
  },
  rhythm: 1.2,
  border: { width: '1px', cards: 'hairline' },
  shadow: { card: 'none', raised: '0 24px 60px -32px rgb(0 0 0 / 0.35)' },
  button: {
    weight: 500,
    tracking: '0.18em',
    case: 'uppercase',
    size: '0.78rem',
    padding: '1.05rem 2.1rem',
    secondary: 'link',
  },
  section: { alternate: 'surface', ornament: 'short-line', headingAlign: 'center' },
  image: { filter: 'saturate(0.92) contrast(1.02)', overlay: 0.42, overlayShape: 'gradient' },
  layout: { maxWidth: '76rem', measure: '38rem' },
};
