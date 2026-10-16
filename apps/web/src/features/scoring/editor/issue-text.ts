'use client';

import { FEATURE_DEFINITIONS, type FeatureKey, PROFILE_PROBLEM_CODES } from '@bf/contracts';
import { useTranslations } from 'next-intl';
import type { Issue } from './draft.ts';

// Draft problems in the editor's words (BF-032): where (section, feature, rule, language) and what, translated; the
// contracts' English message is never shown.

const SECTIONS = {
  weights: 'weights',
  transforms: 'transforms',
  missing: 'transforms',
  gates: 'gates',
  tiers: 'tiers',
  reasonTemplates: 'reasons',
} as const;

const isFeature = (value: unknown): value is FeatureKey =>
  typeof value === 'string' && value in FEATURE_DEFINITIONS;

export function useIssueText(locale: 'en' | 'fr'): (issue: Issue) => { where: string; what: string } {
  const t = useTranslations('scoringEditor.problems');
  const sections = useTranslations('scoringEditor.sections');
  return (issue) => {
    const [head, second, , fourth] = issue.path;
    const section =
      typeof head === 'string' && head in SECTIONS ? SECTIONS[head as keyof typeof SECTIONS] : null;
    const parts = [section ? sections(section) : t('profile')];
    if (head === 'gates' && typeof second === 'number') parts.push(t('rule', { n: second + 1 }));
    else if (isFeature(second)) parts.push(FEATURE_DEFINITIONS[second].label[locale]);
    if (head === 'reasonTemplates' && (fourth === 'en' || fourth === 'fr'))
      parts.push(t(`language.${fourth}`));
    let what: string;
    if (
      (PROFILE_PROBLEM_CODES as readonly string[]).includes(issue.code) ||
      issue.code === 'incomplete_gate'
    ) {
      what = t(`codes.${issue.code as (typeof PROFILE_PROBLEM_CODES)[number] | 'incomplete_gate'}`);
    } else if (head === 'reasonTemplates' && issue.code === 'schema:too_small') what = t('bothLanguages');
    else if (issue.code === 'schema:too_small' || issue.code === 'schema:too_big') what = t('range');
    else if (issue.code === 'schema:invalid_format') what = t('format');
    else what = t('invalid');
    return { where: parts.join(' › '), what };
  };
}
