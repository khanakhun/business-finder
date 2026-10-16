import type { Theme } from '@bf/site-schema';

export type StyleFamilyId = Theme['style'];

/**
 * A design family as data (Strategy): type, rhythm, borders, shadows, buttons, section backgrounds and image
 * treatment. `familyVars` turns it into CSS variables; the stylesheet reads only those, so a family is added or tuned
 * here without touching a component.
 */
export interface StyleFamily {
  readonly id: StyleFamilyId;
  readonly type: {
    /** Display (hero) size: a fluid clamp. */
    readonly display: string;
    /** Section heading size. */
    readonly h2: string;
    /** Item heading size. */
    readonly h3: string;
    readonly headingWeight: number;
    readonly headingTracking: string;
    readonly headingLeading: number;
    readonly headingCase: 'none' | 'uppercase';
    /** Body text size and line height. */
    readonly body: string;
    readonly bodyLeading: number;
    /** Lead paragraphs (hero subtitle, intros). */
    readonly lead: string;
    readonly eyebrowSize: string;
    readonly eyebrowTracking: string;
    readonly eyebrowCase: 'none' | 'uppercase';
    readonly eyebrowWeight: number;
  };
  /** Vertical rhythm: a factor on the theme density's section spacing. */
  readonly rhythm: number;
  readonly border: { readonly width: string; readonly cards: 'none' | 'hairline' | 'line' };
  readonly shadow: { readonly card: string; readonly raised: string };
  readonly button: {
    readonly weight: number;
    readonly tracking: string;
    readonly case: 'none' | 'uppercase';
    readonly size: string;
    readonly padding: string;
    /** The secondary button: outlined, or a text link with an underline. */
    readonly secondary: 'outline' | 'link';
  };
  readonly section: {
    /** Every other section on the surface colour (`surface`), or all on the background with a rule (`rule`). */
    readonly alternate: 'surface' | 'rule' | 'none';
    /** The accent rule under section headings. */
    readonly ornament: 'none' | 'line' | 'short-line';
    /** Section headings centred or left-aligned. */
    readonly headingAlign: 'center' | 'start';
  };
  readonly image: {
    /** A CSS filter on photos (a tone), or none. */
    readonly filter: string;
    /** Darkening over photos that carry text (0–1). */
    readonly overlay: number;
    /** The overlay's shape: flat, or a gradient from the bottom. */
    readonly overlayShape: 'flat' | 'gradient';
  };
  /** Container width and text measure. */
  readonly layout: { readonly maxWidth: string; readonly measure: string };
}
