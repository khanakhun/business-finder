import type { StyleFamily } from './types.ts';

/** Clean and geometric: bold tight headings, crisp cards with soft shadows, compact labels, left-aligned sections. */
export const modern: StyleFamily = {
  id: 'modern',
  type: {
    display: 'clamp(2.5rem, 1.5rem + 4.4vw, 4.6rem)',
    h2: 'clamp(1.8rem, 1.35rem + 1.8vw, 2.75rem)',
    h3: '1.25rem',
    headingWeight: 700,
    headingTracking: '-0.03em',
    headingLeading: 1.05,
    headingCase: 'none',
    body: '1rem',
    bodyLeading: 1.65,
    lead: 'clamp(1.0625rem, 1rem + 0.35vw, 1.25rem)',
    eyebrowSize: '0.8125rem',
    eyebrowTracking: '0.08em',
    eyebrowCase: 'uppercase',
    eyebrowWeight: 600,
  },
  rhythm: 1,
  border: { width: '1px', cards: 'line' },
  shadow: {
    card: '0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px -12px rgb(0 0 0 / 0.12)',
    raised: '0 2px 4px rgb(0 0 0 / 0.04), 0 24px 48px -24px rgb(0 0 0 / 0.25)',
  },
  button: {
    weight: 600,
    tracking: '0',
    case: 'none',
    size: '0.975rem',
    padding: '0.85rem 1.5rem',
    secondary: 'outline',
  },
  section: { alternate: 'surface', ornament: 'none', headingAlign: 'start' },
  image: { filter: 'none', overlay: 0.5, overlayShape: 'gradient' },
  layout: { maxWidth: '78rem', measure: '40rem' },
};
