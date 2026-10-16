import type { StyleFamily } from './types.ts';

/** Friendly and earthy: soft display serif, rounded warmth, gentle shadows, accent labels in sentence case. */
export const warm: StyleFamily = {
  id: 'warm',
  type: {
    display: 'clamp(2.5rem, 1.5rem + 4.4vw, 4.5rem)',
    h2: 'clamp(1.85rem, 1.4rem + 1.9vw, 2.85rem)',
    h3: '1.3rem',
    headingWeight: 500,
    headingTracking: '-0.015em',
    headingLeading: 1.1,
    headingCase: 'none',
    body: '1.0625rem',
    bodyLeading: 1.7,
    lead: 'clamp(1.125rem, 1rem + 0.4vw, 1.3rem)',
    eyebrowSize: '0.9375rem',
    eyebrowTracking: '0.01em',
    eyebrowCase: 'none',
    eyebrowWeight: 600,
  },
  rhythm: 1.05,
  border: { width: '1px', cards: 'none' },
  shadow: {
    card: '0 1px 2px rgb(60 30 0 / 0.05), 0 12px 32px -18px rgb(60 30 0 / 0.22)',
    raised: '0 24px 56px -28px rgb(60 30 0 / 0.35)',
  },
  button: {
    weight: 600,
    tracking: '0.005em',
    case: 'none',
    size: '1rem',
    padding: '0.9rem 1.6rem',
    secondary: 'outline',
  },
  section: { alternate: 'surface', ornament: 'none', headingAlign: 'center' },
  image: { filter: 'saturate(1.05) sepia(0.04)', overlay: 0.45, overlayShape: 'gradient' },
  layout: { maxWidth: '74rem', measure: '38rem' },
};
