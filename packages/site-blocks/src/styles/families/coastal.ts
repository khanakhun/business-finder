import type { StyleFamily } from './types.ts';

/** Light and airy: open letter-spacing, soft sea-light shadows, centred sections, a thin accent line like a horizon. */
export const coastal: StyleFamily = {
  id: 'coastal',
  type: {
    display: 'clamp(2.5rem, 1.5rem + 4.4vw, 4.75rem)',
    h2: 'clamp(1.8rem, 1.35rem + 1.9vw, 2.8rem)',
    h3: '1.3rem',
    headingWeight: 500,
    headingTracking: '0',
    headingLeading: 1.12,
    headingCase: 'none',
    body: '1.0625rem',
    bodyLeading: 1.75,
    lead: 'clamp(1.125rem, 1rem + 0.4vw, 1.3rem)',
    eyebrowSize: '0.78rem',
    eyebrowTracking: '0.22em',
    eyebrowCase: 'uppercase',
    eyebrowWeight: 600,
  },
  rhythm: 1.1,
  border: { width: '1px', cards: 'none' },
  shadow: {
    card: '0 1px 2px rgb(10 40 60 / 0.05), 0 16px 40px -24px rgb(10 40 60 / 0.25)',
    raised: '0 28px 64px -32px rgb(10 40 60 / 0.4)',
  },
  button: {
    weight: 600,
    tracking: '0.06em',
    case: 'none',
    size: '0.95rem',
    padding: '0.95rem 1.75rem',
    secondary: 'outline',
  },
  section: { alternate: 'surface', ornament: 'line', headingAlign: 'center' },
  image: { filter: 'saturate(1.04) brightness(1.02)', overlay: 0.38, overlayShape: 'gradient' },
  layout: { maxWidth: '76rem', measure: '38rem' },
};
