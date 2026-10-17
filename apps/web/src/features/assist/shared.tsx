'use client';

import type { BestTime, CallWorkspace } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { PhoneIcon } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import * as React from 'react';

// Pieces shared by the business Call tab and the call list (BF-057).

type Decision = CallWorkspace['compliance']['phone'];

const VARIANT: Record<string, 'secondary' | 'outline' | 'destructive'> = {
  allowed: 'secondary',
  allowed_with_conditions: 'outline',
  manual_only: 'outline',
  blocked: 'destructive',
};

/** A channel's compliance decision with its reasons (shown before any call or message). */
export function ChannelDecision({
  label,
  decision,
}: {
  readonly label: string;
  readonly decision: Decision;
}) {
  const t = useTranslations('assist.decision');
  const locale = useLocale() === 'fr' ? 'fr' : 'en';
  const known = ['allowed', 'allowed_with_conditions', 'manual_only', 'blocked'].includes(decision.decision);
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{label}</span>
        <Badge variant={VARIANT[decision.decision] ?? 'outline'}>
          {known ? t(decision.decision as 'allowed') : decision.decision}
        </Badge>
      </p>
      {decision.reasons.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {decision.reasons.map((reason) => (
            <li key={reason.code}>{reason.message[locale]}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** "Good time to call now", or the next good moment in the business's and the user's time zones. */
export function BestTimeLine({ bestTime }: { readonly bestTime: BestTime }) {
  const t = useTranslations('assist.bestTime');
  const format = useFormatter();
  const userZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (bestTime.goodNow)
    return (
      <p className="text-sm">
        <Badge variant="secondary">{t('now')}</Badge>
      </p>
    );
  if (!bestTime.nextAt) return <p className="text-sm text-muted-foreground">{t('unknown')}</p>;
  const at = new Date(bestTime.nextAt);
  const options = { weekday: 'short', hour: '2-digit', minute: '2-digit' } as const;
  const there = format.dateTime(at, { ...options, timeZone: bestTime.timeZone });
  const here = format.dateTime(at, { ...options, timeZone: userZone });
  return (
    <p className="text-sm">
      {t(bestTime.reason === 'rush' ? 'rush' : 'closed')}{' '}
      <span className="font-medium">{t('next', { there })}</span>
      {userZone !== bestTime.timeZone ? (
        <span className="text-muted-foreground"> {t('yours', { here })}</span>
      ) : null}
    </p>
  );
}

/** A one-tap `tel:` link; tapping starts the call timer. */
export function DialButton({
  e164,
  onDial,
  size = 'lg',
}: {
  readonly e164: string;
  readonly onDial: () => void;
  readonly size?: 'lg' | 'default';
}) {
  const t = useTranslations('assist');
  return (
    <Button asChild size={size} className="min-h-11">
      <a href={`tel:${e164}`} onClick={onDial}>
        <PhoneIcon aria-hidden />
        {t('call', { number: e164 })}
      </a>
    </Button>
  );
}

/** The call timer: started by the dial button; the outcome form opens when the page is visible again. */
export function useDialTimer(onReturn: (seconds: number) => void) {
  const [startedAt, setStartedAt] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const returned = React.useRef(onReturn);
  returned.current = onReturn;
  React.useEffect(() => {
    if (startedAt === null) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    let hidden = false;
    const visibility = () => {
      if (document.visibilityState === 'hidden') hidden = true;
      else if (hidden) returned.current(Math.round((Date.now() - startedAt) / 1_000));
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [startedAt]);
  return {
    running: startedAt !== null,
    elapsed: startedAt === null ? 0 : Math.max(0, Math.round((now - startedAt) / 1_000)),
    start: () => {
      setNow(Date.now());
      setStartedAt(Date.now());
    },
    stop: () => setStartedAt(null),
  };
}

export const formatDuration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** `https://wa.me/<digits>?text=…` (the same link the API builds). */
export const waLink = (e164: string, text: string) =>
  `https://wa.me/${e164.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
