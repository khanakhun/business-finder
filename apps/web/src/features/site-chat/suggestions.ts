// Suggested prompts by what is selected (BF-047): a section's type gives the most useful ones; otherwise site-wide.
// Message keys under `siteChat.suggestions`.

const BY_TYPE: Record<string, readonly string[]> = {
  hero: ['shorter', 'premium', 'split'],
  gallery: ['tropical', 'fewerPhotos'],
  services: ['clearer', 'prices'],
  menu: ['breakfast', 'clearer'],
  testimonials: ['realReviews'],
  contact: ['whatsapp', 'hours'],
};

const SITE = ['warmer', 'calmerPalette', 'translateEn', 'menuPage'] as const;

export function suggestionsFor(blockType: string | null): readonly string[] {
  return (blockType ? BY_TYPE[blockType] : undefined) ?? SITE;
}
