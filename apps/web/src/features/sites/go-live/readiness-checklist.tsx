'use client';

import type { GoLiveCheck, GoLiveReadiness } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { CheckCircle2Icon, CircleAlertIcon, CircleXIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

// The go-live checklist (BF-062): each check passes, warns or fails, with the step or page that fixes it.

export type GoLiveStep = 'readiness' | 'legal' | 'routing' | 'domains' | 'publish';

const ICON = {
  pass: <CheckCircle2Icon aria-hidden className="size-4 text-emerald-600" />,
  warn: <CircleAlertIcon aria-hidden className="size-4 text-amber-600" />,
  fail: <CircleXIcon aria-hidden className="size-4 text-destructive" />,
} as const;

/** A fix inside the wizard (`?step=`) switches step; the others open their page. */
function fixTarget(check: GoLiveCheck, siteId: string): { step: GoLiveStep } | { href: string } | null {
  if (!check.fix) return null;
  const step = new URL(check.fix, 'http://x').searchParams.get('step');
  if (step === 'legal' || step === 'routing') return { step };
  // DECISION(BF-062): the dashboard has no site detail page yet (`?tab=assets|quality`); the editor holds the site's
  // assets and its quality report, so those fixes open it.
  if (check.fix.includes('?tab=')) return { href: `/sites/${siteId}/edit` };
  return { href: check.fix };
}

export function ReadinessChecklist({
  siteId,
  readiness,
  onStep,
}: {
  readonly siteId: string;
  readonly readiness: GoLiveReadiness;
  readonly onStep: (step: GoLiveStep) => void;
}) {
  const t = useTranslations('goLive.checks');
  return (
    <ul className="divide-y rounded-lg border">
      {readiness.checks.map((check) => {
        const target = fixTarget(check, siteId);
        return (
          <li key={check.id} className="flex items-start gap-3 p-3 text-sm">
            <span className="pt-0.5">{ICON[check.status]}</span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="flex items-center gap-2 font-medium">
                {t(`${check.id}`)}
                <Badge variant={check.status === 'fail' ? 'destructive' : 'secondary'}>
                  {t(`status.${check.status}`)}
                </Badge>
              </p>
              <p className="text-muted-foreground">{check.message}</p>
            </div>
            {target && check.status !== 'pass' ? (
              'step' in target ? (
                <Button type="button" size="sm" variant="outline" onClick={() => onStep(target.step)}>
                  {t('fix')}
                </Button>
              ) : (
                <Button asChild size="sm" variant="outline">
                  <Link href={target.href}>{t('fix')}</Link>
                </Button>
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
