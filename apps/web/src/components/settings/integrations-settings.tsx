'use client';

import type { SecretList, SecretName, SecretSummary } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { FormError, PasswordField, useErrorMessage } from '@/components/auth/fields.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { Forbidden } from './forbidden.tsx';
import { SettingsSection } from './section.tsx';

const PROVIDERS = ['google', 'anthropic', 'openai', 'foursquare', 'huggingface', 'unsplash'] as const;
type Provider = (typeof PROVIDERS)[number];

export function IntegrationsSettings() {
  const t = useTranslations();
  const canManage = usePermission('settings:manage');
  const labels = useErrorLabels();
  const query = useQuery({
    queryKey: queryKeys.workspace.secrets(),
    queryFn: async () => (await apiClient().GET('/v1/workspace/secrets')).data as SecretList,
    enabled: canManage,
  });
  if (!canManage) return <Forbidden />;
  if (query.isError) {
    return (
      <ErrorState
        problem={toProblemLike(query.error, t('errors.pageTitle'))}
        labels={labels}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <Skeleton className="h-96 max-w-3xl" />;
  const groups = PROVIDERS.map((provider) => ({
    provider,
    items: query.data.items.filter((item) => item.provider === provider),
  })).filter((group) => group.items.length > 0);
  return (
    <div className="grid gap-6">
      {groups.map((group) => (
        <SettingsSection
          key={group.provider}
          id={`provider-${group.provider}`}
          title={t(`integrations.providers.${group.provider as Provider}`)}
        >
          <ul className="grid gap-3">
            {group.items.map((item) => (
              <SecretRow key={item.name} secret={item} />
            ))}
          </ul>
        </SettingsSection>
      ))}
    </div>
  );
}

function SecretRow({ secret }: { readonly secret: SecretSummary }) {
  const t = useTranslations('integrations');
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const name = t(`secrets.${secret.name}`);
  const test = useMutation({
    mutationFn: async () =>
      (
        await apiClient().POST('/v1/workspace/secrets/{name}/test', {
          params: { path: { name: secret.name } },
        })
      ).data,
    onSuccess: async (result) => {
      const toast = await getToast();
      if (result?.ok) toast.success(t('testOk', { name }), { description: result.message });
      else toast.error(t('testFailed', { name }), { description: result?.message });
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
  });
  const status =
    secret.source === 'workspace'
      ? t('statusWorkspace')
      : secret.source === 'global'
        ? t('statusGlobal')
        : t('statusNone');

  return (
    <li className="flex flex-col gap-3 rounded-md border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium">{name}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge
            variant={secret.source === null ? 'outline' : 'secondary'}
            data-testid={`secret-status-${secret.name}`}
          >
            {status}
          </Badge>
          {secret.source === 'workspace' && secret.last4 ? (
            <span>{t('endingIn', { last4: secret.last4 })}</span>
          ) : null}
          {secret.source === 'workspace' ? (
            <span>
              {secret.lastUsedAt
                ? t('lastUsed', {
                    date: format.dateTime(new Date(secret.lastUsedAt), { dateStyle: 'medium' }),
                  })
                : t('neverUsed')}
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {secret.testable && secret.source !== null ? (
          <Button
            variant="outline"
            size="sm"
            disabled={test.isPending}
            onClick={() => test.mutate()}
            aria-label={`${t('test')} — ${name}`}
          >
            {t('test')}
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
          aria-label={`${secret.source === 'workspace' ? t('replace') : t('add')} — ${name}`}
        >
          {secret.source === 'workspace' ? t('replace') : t('add')}
        </Button>
        {secret.source === 'workspace' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDeleting(true)}
            aria-label={`${t('delete')} — ${name}`}
          >
            {t('delete')}
          </Button>
        ) : null}
      </div>
      <SecretDialog secret={secret.name} name={name} open={editing} onOpenChange={setEditing} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('deleteConfirm', { name })}
        description={t('deleteBody')}
        confirmLabel={t('delete')}
        onConfirm={async () => {
          await apiClient().DELETE('/v1/workspace/secrets/{name}', {
            params: { path: { name: secret.name } },
          });
          await client.invalidateQueries({ queryKey: queryKeys.workspace.secrets() });
          (await getToast()).success(t('deleted', { name }));
        }}
      />
    </li>
  );
}

function SecretDialog({
  secret,
  name,
  open,
  onOpenChange,
}: {
  readonly secret: SecretName;
  readonly name: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('integrations');
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () =>
      apiClient().PUT('/v1/workspace/secrets/{name}', {
        params: { path: { name: secret } },
        body: { value },
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.workspace.secrets() });
      (await getToast()).success(t('saved', { name }));
      close(false);
    },
    onError: (caught) => setError(errorMessage(caught)),
  });
  // The typed value never outlives the dialog.
  const close = (next: boolean) => {
    if (!next) {
      setValue('');
      setError(null);
    }
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{name}</DialogTitle>
            <DialogDescription>{t('valueHint')}</DialogDescription>
          </DialogHeader>
          <FormError message={error} />
          <PasswordField
            label={t('valueLabel')}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending || value.trim() === ''}>
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
