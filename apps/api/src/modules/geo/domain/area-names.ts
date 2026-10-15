// Accent- and spelling-insensitive area names (BF-017): "St Barth", "Saint-Barthélemy", "ST-BARTHÉLEMY" compare equal
// after normalization; abbreviations of Saint/Sainte/Mount expand.

const ABBREVIATIONS: Record<string, string> = {
  st: 'saint',
  ste: 'sainte',
  mt: 'mont',
  ft: 'fort',
  pt: 'pointe',
};

export function normalizeAreaName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’`]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => ABBREVIATIONS[word] ?? word)
    .join(' ');
}
