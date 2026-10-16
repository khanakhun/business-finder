import { BLOCK_TYPES, blockVariants } from '@bf/site-schema';

// What the browser suites look at (BF-034): the fixture sites (dist/sites/<fixture>/<style>/) and the gallery's
// isolated blocks (dist/gallery/blocks/<style>/<type>/<variant>.html).

export const FIXTURES = [
  'salon-gustavia',
  'cafe-saint-jean',
  'hardware-store-lorient',
  'villa-agency',
] as const;
export const STYLES = ['luxe', 'modern', 'warm', 'minimal', 'coastal'] as const;

/** Each fixture's pages (their URL paths under a style), in its default locale and the other one. */
export const PAGES: Readonly<Record<(typeof FIXTURES)[number], readonly string[]>> = {
  'salon-gustavia': ['', 'prestations/', 'contact/', 'en/', 'en/prestations/', 'en/contact/'],
  'cafe-saint-jean': ['', 'carte/', 'en/', 'en/carte/'],
  'hardware-store-lorient': ['', 'le-magasin/', 'en/', 'en/le-magasin/'],
  'villa-agency': ['', 'villas/', 'mentions-legales/', 'fr/', 'fr/villas/', 'fr/mentions-legales/'],
};

export const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
} as const;

export const BLOCK_VARIANTS = BLOCK_TYPES.flatMap((type) =>
  blockVariants(type).map((variant) => ({ type, variant })),
);

/** The two contrasting styles every block is captured in. */
export const BLOCK_STYLES = ['luxe', 'modern'] as const;
