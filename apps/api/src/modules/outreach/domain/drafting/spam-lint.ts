// Spam-trigger lint (BF-051): data-driven FR/EN phrases mail filters and readers distrust, shouting, and exclamation
// runs. Warnings, not errors: a person may keep a phrase on purpose.

const PHRASES: Record<'en' | 'fr', readonly string[]> = {
  en: [
    '100% free',
    'act now',
    'urgent',
    'limited time',
    'once in a lifetime',
    'guaranteed',
    'risk-free',
    'no obligation!',
    'click here',
    'buy now',
    'winner',
    'cash',
    'cheap',
    'best price',
    'special promotion',
    'dear friend',
  ],
  fr: [
    '100% gratuit',
    '100 % gratuit',
    'gratuit !',
    'urgent',
    'offre limitée',
    'offre exceptionnelle',
    'dernière chance',
    'garanti',
    'sans risque',
    'cliquez ici',
    'achetez maintenant',
    'gagnant',
    'pas cher',
    'meilleur prix',
    'promotion spéciale',
    'cher ami',
  ],
};

export interface SpamWarning {
  readonly code: 'spam_phrase' | 'shouting' | 'exclamations';
  readonly detail: string;
}

export function spamWarnings(text: string, locale: 'en' | 'fr'): SpamWarning[] {
  const lower = text.toLowerCase();
  const warnings: SpamWarning[] = PHRASES[locale]
    .filter((phrase) => lower.includes(phrase))
    .map((phrase) => ({ code: 'spam_phrase' as const, detail: phrase }));
  const shouted = text.match(/\b[A-ZÀ-Ý]{5,}\b/g) ?? [];
  if (shouted.length > 0) warnings.push({ code: 'shouting', detail: shouted.slice(0, 3).join(', ') });
  const exclamations = (text.match(/!/g) ?? []).length;
  if (exclamations > 1 || /!{2,}/.test(text))
    warnings.push({ code: 'exclamations', detail: String(exclamations) });
  return warnings;
}
