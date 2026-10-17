'use client';

import type { ComplianceDecision, ComplianceDecisionValue } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { cn } from '@bf/ui/lib/utils';
import { CircleCheckIcon, ListChecksIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

// The compliance panel (BF-049), reused by outreach (BF-051/BF-052/BF-057) and the business page: the decision, why
// (in the reader's language), what every message must contain, and what to do instead when it is not allowed.

export const DECISION_STYLE: Record<ComplianceDecisionValue, string> = {
  allowed: 'border-emerald-600/40 bg-emerald-600/15 text-emerald-900 dark:text-emerald-100',
  allowed_with_conditions: 'border-sky-600/40 bg-sky-600/15 text-sky-900 dark:text-sky-100',
  manual_only: 'border-amber-600/40 bg-amber-500/15 text-amber-900 dark:text-amber-100',
  blocked: 'border-destructive/40 bg-destructive/10 text-destructive',
};

export function DecisionBadge({ decision }: { readonly decision: ComplianceDecisionValue }) {
  const t = useTranslations('compliance.decision');
  return (
    <Badge variant="outline" className={cn(DECISION_STYLE[decision])}>
      {t(decision)}
    </Badge>
  );
}

export function CompliancePanel({ decision }: { readonly decision: ComplianceDecision }) {
  const t = useTranslations('compliance.panel');
  const elements = useTranslations('compliance.elements');
  const locale = useLocale() === 'fr' ? 'fr' : 'en';
  return (
    <div className="space-y-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <DecisionBadge decision={decision.decision} />
        <span className="text-xs text-muted-foreground">
          {t('jurisdictions', { list: decision.jurisdictions.join(', ') })}
        </span>
        {decision.autoSendPermitted ? <Badge variant="secondary">{t('autoSend')}</Badge> : null}
      </p>
      <ul className="list-disc space-y-0.5 pl-5">
        {decision.reasons.map((reason, index) => (
          <li key={`${reason.code}-${index}`}>{reason.message[locale]}</li>
        ))}
      </ul>
      {decision.requiredElements.length > 0 ? (
        <section className="space-y-1">
          <h4 className="flex items-center gap-1 text-xs font-medium uppercase text-muted-foreground">
            <ListChecksIcon aria-hidden className="size-3" />
            {t('required')}
          </h4>
          <ul className="grid gap-0.5 sm:grid-cols-2">
            {decision.requiredElements.map((element) => (
              <li key={element} className="flex items-start gap-1.5">
                <CircleCheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                {elements(element)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {decision.alternatives.length > 0 ? (
        <section className="space-y-1">
          <h4 className="text-xs font-medium uppercase text-muted-foreground">{t('alternatives')}</h4>
          <ul className="list-disc space-y-0.5 pl-5">
            {decision.alternatives.map((alternative) => (
              <li key={alternative.code}>{alternative.label[locale]}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
