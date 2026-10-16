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

const LOCALE_TAG: Record<Locale, string> = { en: 'en-GB', fr: 'fr-FR' };
const FORMATS = new Map<string, Intl.NumberFormat>();
const PLURALS = { en: new Intl.PluralRules('en-GB'), fr: new Intl.PluralRules('fr-FR') };

const format = (value: number, locale: Locale, digits: number) => {
  const key = `${locale}:${digits}`;
  let formatter = FORMATS.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE_TAG[locale], { maximumFractionDigits: digits });
    FORMATS.set(key, formatter);
  }
  return formatter.format(value);
};

/** `3,5 ans`, `1 year`, `0 years`: the plural rule of the locale, applied to the number as displayed. */
const counted = (value: number, locale: Locale, digits: number, one: string, many: string) => {
  const shown = Number(value.toFixed(digits));
  return `${format(value, locale, digits)} ${PLURALS[locale].select(shown) === 'one' ? one : many}`;
};

/** A value in its unit, as a sentence reads it (`42/100`, `3,5 s`, `35 %`, `2 years`…). */
export function formatValue(unit: FeatureUnit, value: FeatureValue, locale: Locale): string {
  if (typeof value !== 'number') return String(value);
  switch (unit) {
    case 'score100':
      return `${format(value, locale, 0)}/100`;
    case 'score10':
      return `${format(value, locale, 1)}/10`;
    case 'rating':
      return `${format(value, locale, 1)}/5`;
    case 'seconds':
      return `${format(value, locale, 1)} s`;
    case 'share':
      // French puts a (narrow) space before the percent sign.
      return locale === 'fr'
        ? `${format(value * 100, locale, 0)}\u202f%`
        : `${format(value * 100, locale, 0)}%`;
    case 'years':
      return locale === 'fr'
        ? counted(value, locale, 1, 'an', 'ans')
        : counted(value, locale, 1, 'year', 'years');
    case 'days':
      return locale === 'fr'
        ? counted(value, locale, 0, 'jour', 'jours')
        : counted(value, locale, 0, 'day', 'days');
    case 'log_count':
      return format(Math.round(10 ** value - 1), locale, 0);
    default:
      return format(value, locale, 1);
  }
}

/** The text key a value reads: its boolean or enum value, `below`/`above` its feature's pivot, else `value`. */
function keysOf(raw: FeatureValue, pivot: number | undefined): string[] {
  if (typeof raw === 'boolean' || typeof raw === 'string') return [String(raw), 'value'];
  if (typeof raw === 'number' && pivot !== undefined) return [raw < pivot ? 'below' : 'above', 'value'];
  return ['value'];
}

function text(config: ScoringProfileConfig, contribution: ScoreContribution) {
  const definition = FEATURE_DEFINITIONS[contribution.feature];
  const raw = contribution.rawValue;
  // The profile's texts win over the registry's; within each, the most specific key.
  const keys = keysOf(raw, definition.pivot);
  const pick = (texts: ReasonTexts | undefined) =>
    keys.map((key) => texts?.[key]).find((template) => template !== undefined);
  const template = pick(config.reasonTemplates[contribution.feature]) ?? pick(definition.reasons);
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
