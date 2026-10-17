'use client';

import { OUTREACH_CHANNELS } from '@bf/contracts';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useFormatter, useTranslations } from 'next-intl';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import type { BusinessTabProps } from '@/features/business/tabs/registry.ts';
import { usePermission } from '@/lib/session.tsx';
import { useDecisions, useEvaluation } from './api.ts';
import { CompliancePanel, DecisionBadge } from './compliance-panel.tsx';

// The business page's Compliance tab (BF-049): what the gate would decide today on each channel for a new-website
// offer (a preview — nothing is recorded) and the decisions recorded for this business.

export function ComplianceTab({ business }: BusinessTabProps) {
  const t = useTranslations('compliance.tab');
  const canEvaluate = usePermission('outreach:send');
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t('today')}</h2>
        <p className="text-xs text-muted-foreground">{t('todayHint')}</p>
        {canEvaluate ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {OUTREACH_CHANNELS.map((channel) => (
              <ChannelEvaluation key={channel} businessId={business.id} channel={channel} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('noPermission')}</p>
        )}
      </section>
      <History businessId={business.id} />
    </div>
  );
}

function ChannelEvaluation({
  businessId,
  channel,
}: {
  readonly businessId: string;
  readonly channel: (typeof OUTREACH_CHANNELS)[number];
}) {
  const channelName = useTranslations('compliance.channels');
  const t = useTranslations('compliance.tab');
  const errorLabels = useErrorLabels();
  const evaluation = useEvaluation(businessId, channel, 'new_website', true);
  return (
    <article className="space-y-2 rounded-lg border p-3">
      <h3 className="text-sm font-medium">{channelName(channel)}</h3>
      {evaluation.isError ? (
        <ErrorState
          problem={toProblemLike(evaluation.error, t('loadError'))}
          labels={errorLabels}
          onRetry={() => void evaluation.refetch()}
        />
      ) : evaluation.data ? (
        <CompliancePanel decision={evaluation.data} />
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
    </article>
  );
}

function History({ businessId }: { readonly businessId: string }) {
  const t = useTranslations('compliance.tab');
  const channelName = useTranslations('compliance.channels');
  const format = useFormatter();
  const decisions = useDecisions(businessId);
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">{t('history')}</h2>
      {decisions.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : (decisions.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noHistory')}</p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {(decisions.data ?? []).map((decision) => (
            <li
              key={decision.id ?? decision.evaluatedAt}
              className="flex flex-wrap items-center gap-2 px-3 py-2"
            >
              <DecisionBadge decision={decision.decision} />
              <span>{channelName(decision.channel)}</span>
              <span className="text-xs text-muted-foreground">{t(`stage.${decision.stage}`)}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {format.dateTime(new Date(decision.evaluatedAt), { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
