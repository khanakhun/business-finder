import {
  FEATURE_DEFINITIONS,
  type FeatureUnit,
  type FeatureValue,
  type ReasonTexts,
  type ScoreContribution,
  type ScoreReason,
  type ScoringProfileConfig,
} from '@bf/contracts';

// Reasons (BF-031): the strongest contributions each way, in plain EN/FR for a non-technical partner. Texts come from
// the profile's `reasonTemplates`, else the registry; `{value}` is the value in the feature's unit.

export const REASONS_PER_DIRECTION = 3;

type Locale = 'en' | 'fr';

const number = (value: number, locale: Locale, digits = 1) =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', { maximumFractionDigits: digits }).format(value);

const plural = (value: number, one: string, many: string) => (Math.abs(value) < 2 ? one : many);

/** A value in its unit, as a sentence reads it (`42/100`, `3,5 s`, `35 %`, `2 years`…). */
export function formatValue(unit: FeatureUnit, value: FeatureValue, locale: Locale): string {
  if (typeof value !== 'number') return String(value);
  switch (unit) {
    case 'score100':
      return `${number(value, locale, 0)}/100`;
    case 'score10':
      return `${number(value, locale)}/10`;
    case 'rating':
      return `${number(value, locale)}/5`;
    case 'seconds':
      return `${number(value, locale)} s`;
    case 'share':
      // French puts a (narrow) space before the percent sign.
      return locale === 'fr' ? `${number(value * 100, locale, 0)} %` : `${number(value * 100, locale, 0)}%`;
    case 'years':
      return locale === 'fr'
        ? `${number(value, locale)} ${plural(value, 'an', 'ans')}`
        : `${number(value, locale)} ${plural(value, 'year', 'years')}`;
    case 'days':
      return locale === 'fr'
        ? `${number(value, locale, 0)} ${plural(value, 'jour', 'jours')}`
        : `${number(value, locale, 0)} ${plural(value, 'day', 'days')}`;
    default:
      return number(value, locale);
  }
}

function text(config: ScoringProfileConfig, contribution: ScoreContribution) {
  const definition = FEATURE_DEFINITIONS[contribution.feature];
  const texts: ReasonTexts = { ...definition.reasons, ...config.reasonTemplates[contribution.feature] };
  const raw = contribution.rawValue;
  const template =
    (typeof raw === 'boolean' || typeof raw === 'string' ? texts[String(raw)] : undefined) ?? texts.value;
  if (!template) return null;
  const fill = (locale: Locale) =>
    template[locale].replaceAll('{value}', formatValue(definition.unit, raw, locale));
  return { en: fill('en'), fr: fill('fr') };
}

/** Up to three reasons each way, strongest first (ties: registry order, so the choice is deterministic). */
export function selectReasons(
  config: ScoringProfileConfig,
  contributions: readonly ScoreContribution[],
): ScoreReason[] {
  const pick = (direction: 'positive' | 'negative') =>
    contributions
      .map((contribution, index) => ({ contribution, index }))
      .filter(({ contribution }) =>
        direction === 'positive' ? contribution.contribution > 0 : contribution.contribution < 0,
      )
      .sort(
        (a, b) =>
          Math.abs(b.contribution.contribution) - Math.abs(a.contribution.contribution) || a.index - b.index,
      )
      .flatMap(({ contribution }) => {
        const sentence = text(config, contribution);
        return sentence
          ? [
              {
                feature: contribution.feature,
                direction,
                contribution: contribution.contribution,
                text: sentence,
              },
            ]
          : [];
      })
      .slice(0, REASONS_PER_DIRECTION);
  return [...pick('positive'), ...pick('negative')];
}
