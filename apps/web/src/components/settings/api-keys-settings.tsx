'use client';

import type { ApiKeySummary, CreatedApiKey, Permission } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { ErrorState } from '@bf/ui/components/error-state';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@bf/ui/components/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { Field, FormError, useErrorMessage } from '@/components/auth/fields.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { usePermission, useSession } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { Forbidden } from './forbidden.tsx';
import { SettingsSection } from './section.tsx';

const EXPIRY_DAYS = [30, 90, 365] as const;

export function ApiKeysSettings() {
  const t = useTranslations();
  const canManage = usePermission('settings:manage');
  const labels = useErrorLabels();
  const query = useQuery({
    queryKey: queryKeys.identity.apiKeys(),
    queryFn: async () => (await apiClient().GET('/v1/api-keys')).data,
    enabled: canManage,
  });
  const [creating, setCreating] = React.useState(false);
  const [created, setCreated] = React.useState<CreatedApiKey | null>(null);

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
  return (
    <>
      <SettingsSection
        id="api-keys"
        title={t('apiKeys.title')}
        action={
          <Button onClick={() => setCreating(true)}>
            <KeyRoundIcon aria-hidden />
            {t('apiKeys.create')}
          </Button>
        }
      >
        {query.data ? <KeysTable keys={query.data.items} /> : <Skeleton className="h-24" />}
      </SettingsSection>
      {creating ? (
        <CreateKeyDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(key) => {
            setCreating(false);
            setCreated(key);
          }}
        />
      ) : null}
      {created ? <ShowKeyDialog created={created} onClose={() => setCreated(null)} /> : null}
    </>
  );
}

function KeysTable({ keys }: { readonly keys: readonly ApiKeySummary[] }) {
  const t = useTranslations('apiKeys');
  const format = useFormatter();
  const client = useQueryClient();
  const [revoking, setRevoking] = React.useState<ApiKeySummary | null>(null);
  const date = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium' }) : t('neverUsed');

  if (keys.length === 0) return <p className="text-muted-foreground">{t('empty')}</p>;
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('name')}</TableHead>
            <TableHead>{t('status')}</TableHead>
            <TableHead className="hidden md:table-cell">{t('lastUsed')}</TableHead>
            <TableHead className="hidden md:table-cell">{t('expiry')}</TableHead>
            <TableHead className="text-right">{t('revoke')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((key) => {
            const expired = key.expiresAt !== null && Date.parse(key.expiresAt) < Date.now();
            const status = key.revokedAt ? 'revoked' : expired ? 'expired' : 'active';
            return (
              <TableRow key={key.id}>
                <TableCell>
                  <div className="font-medium">{key.name}</div>
                  <code className="text-xs text-muted-foreground">{key.start}…</code>
                </TableCell>
                <TableCell>
                  <Badge variant={status === 'active' ? 'default' : 'secondary'}>{t(status)}</Badge>
                </TableCell>
                <TableCell className="hidden md:table-cell">{date(key.lastUsedAt)}</TableCell>
                <TableCell className="hidden md:table-cell">
                  {key.expiresAt ? date(key.expiresAt) : t('never')}
                </TableCell>
                <TableCell className="text-right">
                  {status === 'active' ? (
                    <Button variant="ghost" size="sm" onClick={() => setRevoking(key)}>
                      {t('revoke')}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {revoking ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => (open ? undefined : setRevoking(null))}
          title={t('revokeConfirm', { name: revoking.name })}
          confirmLabel={t('revoke')}
          onConfirm={async () => {
            await apiClient().DELETE('/v1/api-keys/{apiKeyId}', {
              params: { path: { apiKeyId: revoking.id } },
            });
            await client.invalidateQueries({ queryKey: queryKeys.identity.apiKeys() });
          }}
        />
      ) : null}
    </>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (key: CreatedApiKey) => void;
}) {
  const t = useTranslations('apiKeys');
  const { permissions: mine } = useSession();
  const client = useQueryClient();
  const errorMessage = useErrorMessage();
  const [selected, setSelected] = React.useState<ReadonlySet<Permission>>(new Set());
  const [expiry, setExpiry] = React.useState<string>('90');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const toggle = (permission: Permission, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(permission);
      else next.delete(permission);
      return next;
    });

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name'));
    setError(null);
    setPending(true);
    try {
      const { data } = await apiClient().POST('/v1/api-keys', {
        body: {
          name,
          permissions: [...selected],
          ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) }),
        },
      });
      await client.invalidateQueries({ queryKey: queryKeys.identity.apiKeys() });
      if (data) onCreated(data);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('createTitle')}</DialogTitle>
          <DialogDescription>{t('permissionsHint')}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <FormError message={error} />
          <Field label={t('name')} name="name" required maxLength={64} autoFocus />
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t('permissions')}</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {mine.map((permission) => (
                <div key={permission} className="flex items-center gap-2">
                  <Checkbox
                    id={`perm-${permission}`}
                    checked={selected.has(permission)}
                    onCheckedChange={(value) => toggle(permission, value === true)}
                  />
                  <Label htmlFor={`perm-${permission}`} className="font-mono text-xs font-normal">
                    {permission}
                  </Label>
                </div>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-1.5">
            <Label htmlFor="key-expiry">{t('expiry')}</Label>
            <Select value={expiry} onValueChange={setExpiry}>
              <SelectTrigger id="key-expiry" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_DAYS.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {t('days', { count: days })}
                  </SelectItem>
                ))}
                <SelectItem value="never">{t('never')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending || selected.size === 0}>
              {t('createSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ShowKeyDialog({
  created,
  onClose,
}: {
  readonly created: CreatedApiKey;
  readonly onClose: () => void;
}) {
  const t = useTranslations('apiKeys');
  const [copied, setCopied] = React.useState(false);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('copyTitle')}</DialogTitle>
          <DialogDescription>{t('copyBody')}</DialogDescription>
        </DialogHeader>
        <code
          data-testid="created-api-key"
          className="block break-all rounded-md border bg-muted px-3 py-2 font-mono text-sm"
        >
          {created.key}
        </code>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              await navigator.clipboard.writeText(created.key);
              setCopied(true);
              (await getToast()).success(t('copied'));
            }}
          >
            {copied ? t('copied') : t('copy')}
          </Button>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
