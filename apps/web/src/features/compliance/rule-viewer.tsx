'use client';

import type { PolicyCondition, PolicyDocument } from '@bf/contracts';
import { useLocale, useTranslations } from 'next-intl';
import { DecisionBadge } from './compliance-panel.tsx';

// A policy as readable sentences (BF-049): "If the recipient is a sole trader and the address is personal → Blocked",
// in order (the first rule that matches decides), then "Otherwise → …", with each rule's explanation.

export function RuleViewer({ policy }: { readonly policy: PolicyDocument }) {
  const t = useTranslations('compliance.rules');
  const values = useTranslations('compliance.values');
  const locale = useLocale() === 'fr' ? 'fr' : 'en';
  const condition = (when: PolicyCondition) => {
    const parts = (Object.entries(when) as [keyof PolicyCondition, string[] | undefined][])
      .filter(([, list]) => list && list.length > 0)
      .map(([key, list]) =>
        t('condition', {
          field: t(`fields.${key}`),
          values: (list ?? []).map((value) => values(value as never)).join(t('or')),
        }),
      );
    return parts.length > 0 ? parts.join(t('and')) : t('always');
  };
  return (
    <ol className="space-y-2 text-sm">
      {policy.rules.map((rule) => (
        <li key={rule.id} className="space-y-0.5">
          <p className="flex flex-wrap items-center gap-2">
            <span>{t('if', { condition: condition(rule.when) })}</span>
            <DecisionBadge decision={rule.decision} />
          </p>
          <p className="text-xs text-muted-foreground">{rule.explain[locale]}</p>
        </li>
      ))}
      <li className="space-y-0.5">
        <p className="flex flex-wrap items-center gap-2">
          <span>{policy.rules.length > 0 ? t('otherwise') : t('always')}</span>
          <DecisionBadge decision={policy.default} />
        </p>
        <p className="text-xs text-muted-foreground">{policy.defaultExplain[locale]}</p>
      </li>
    </ol>
  );
}
