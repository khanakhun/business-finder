import type { StyleFamily } from './types.ts';

/** Sparse and typographic: medium-weight headings, hairline rules between sections, no shadows, quiet labels. */
export const minimal: StyleFamily = {
  id: 'minimal',
  type: {
    display: 'clamp(2.3rem, 1.4rem + 4vw, 4.25rem)',
    h2: 'clamp(1.6rem, 1.3rem + 1.4vw, 2.4rem)',
    h3: '1.15rem',
    headingWeight: 500,
    headingTracking: '-0.025em',
    headingLeading: 1.1,
    headingCase: 'none',
    body: '1rem',
    bodyLeading: 1.7,
    lead: 'clamp(1.0625rem, 1rem + 0.3vw, 1.2rem)',
    eyebrowSize: '0.75rem',
    eyebrowTracking: '0.16em',
    eyebrowCase: 'uppercase',
    eyebrowWeight: 500,
  },
  rhythm: 1.15,
  border: { width: '1px', cards: 'hairline' },
  shadow: { card: 'none', raised: 'none' },
  button: {
    weight: 500,
    tracking: '0.01em',
    case: 'none',
    size: '0.95rem',
    padding: '0.8rem 1.4rem',
    secondary: 'link',
  },
  section: { alternate: 'rule', ornament: 'none', headingAlign: 'start' },
  image: { filter: 'grayscale(0.08)', overlay: 0.5, overlayShape: 'flat' },
  layout: { maxWidth: '72rem', measure: '36rem' },
};
