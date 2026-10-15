'use client';

import {
  EMAIL_VERIFIERS,
  type EmailVerifierId,
  type OrgSettings,
  type SmtpPortDiagnostic,
} from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { ErrorState } from '@bf/ui/components/error-state';
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Switch } from '@bf/ui/components/switch';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { getToast } from '@/lib/toast.tsx';
import { moveProvider, verifierRows } from './discovery-order.ts';
import { SettingsSection } from './section.tsx';
import { useWorkspaceSettings } from './workspace-settings.tsx';

/** Settings → Integrations → E-mail verification (BF-028): the verifier chain and the port-25 diagnostic. */
export function EmailVerificationSettings() {
  const t = useTranslations('integrations.emailVerification');
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const settings = useWorkspaceSettings(true);
  const save = useMutation({
    mutationFn: async (emailVerifiers: EmailVerifierId[]) =>
      (await apiClient().PATCH('/v1/workspace/settings', { body: { enrichment: { emailVerifiers } } }))
        .data as OrgSettings,
    onSuccess: async (saved) => {
      client.setQueryData(queryKeys.workspace.settings(), saved);
      (await getToast()).success(t('saved'));
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  const labels = useErrorLabels();
  const errorTitle = useTranslations('errors')('pageTitle');

  if (settings.error) {
    return (
      <SettingsSection id="email-verification" title={t('title')} description={t('description')}>
        <ErrorState
          problem={toProblemLike(settings.error, errorTitle)}
          labels={labels}
          onRetry={() => void settings.refetch()}
        />
      </SettingsSection>
    );
  }
  const chain = settings.data?.enrichment.emailVerifiers;
  return (
    <SettingsSection id="email-verification" title={t('title')} description={t('description')}>
      {!chain ? (
        <Skeleton className="h-48" />
      ) : (
        <div className="grid gap-6">
          <ol className="grid gap-3" aria-label={t('orderLabel')}>
            {verifierRows(chain).map(({ id, used }, index) => {
              const label = t(`verifiers.${id}.label`);
              const inputId = `verifier-${id}`;
              const move = (delta: number) => save.mutate(moveProvider(chain, index, delta));
              return (
                <li
                  key={id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="grid max-w-prose gap-1">
                    <Label htmlFor={inputId}>{label}</Label>
                    <p id={`${inputId}-hint`} className="text-sm text-muted-foreground">
                      {t(`verifiers.${id}.hint`)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {used ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('moveUp', { verifier: label })}
                          disabled={index === 0 || save.isPending}
                          onClick={() => move(-1)}
                        >
                          ↑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('moveDown', { verifier: label })}
                          disabled={index === chain.length - 1 || save.isPending}
                          onClick={() => move(1)}
                        >
                          ↓
                        </Button>
                      </>
                    ) : null}
                    <Switch
                      id={inputId}
                      aria-describedby={`${inputId}-hint`}
                      aria-label={t('use', { verifier: label })}
                      checked={used}
                      // The chain needs at least one verifier.
                      disabled={save.isPending || (used && chain.length === 1)}
                      onCheckedChange={(on) =>
                        save.mutate(on ? [...chain, id] : chain.filter((verifier) => verifier !== id))
                      }
                    />
                  </div>
                </li>
              );
            })}
          </ol>
          {chain.length === 1 ? <p className="text-sm text-muted-foreground">{t('lastOne')}</p> : null}
          <SmtpPortCheck />
        </div>
      )}
    </SettingsSection>
  );
}

function SmtpPortCheck() {
  const t = useTranslations('integrations.emailVerification');
  const errorMessage = useErrorMessage();
  const check = useMutation({
    mutationFn: async () =>
      (await apiClient().POST('/v1/workspace/diagnostics/smtp-port')).data as SmtpPortDiagnostic,
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  const result = check.data;
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <p className="font-medium">{t('portTitle')}</p>
      <p className="text-sm text-muted-foreground">{t('portDescription')}</p>
      <div>
        <Button variant="outline" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
          {t('portCheck')}
        </Button>
      </div>
      <div aria-live="polite" className="grid gap-1 text-sm" data-testid="smtp-port-result">
        {result ? (
          <>
            <p>
              {result.reachable
                ? t('portOpen', { host: result.host ?? '', latency: result.latencyMs ?? 0 })
                : t('portBlocked', { error: t(`portErrors.${result.error ?? 'other'}`) })}
            </p>
            {result.reacherConfigured ? null : <p className="text-muted-foreground">{t('reacherMissing')}</p>}
          </>
        ) : null}
      </div>
    </div>
  );
}
