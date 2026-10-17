'use client';

import {
  type CurrentSuppression,
  SUPPRESSION_REASONS,
  SUPPRESSION_SCOPES,
  type SuppressionScope,
} from '@bf/contracts';
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
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { BanIcon, DownloadIcon, PlusIcon, UploadIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { downloadFromApi } from '@/features/search/bulk-actions/bar.tsx';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useSuppressionActions, useSuppressions } from './api.ts';

// Compliance → Suppressions (BF-055): what is suppressed now (global entries read-only) or the full log, filtered;
// add one, import a CSV (preview then commit), export, and lift one (owners; an unsubscribe needs consent evidence).

const ALL = 'all';

export function SuppressionsPage() {
  const t = useTranslations('complianceAdmin.suppressions');
  const scopeName = useTranslations('complianceAdmin.scopes');
  const reasonName = useTranslations('complianceAdmin.reasons');
  const errorLabels = useErrorLabels();
  const format = useFormatter();
  const canExport = usePermission('settings:manage');
  const canRevoke = usePermission('compliance:manage');
  const [q, setQ] = useQueryState('q', parseAsString.withDefault(''));
  const [scope, setScope] = useQueryState('scope', parseAsString.withDefault(ALL));
  const [reason, setReason] = useQueryState('reason', parseAsString.withDefault(ALL));
  const [view, setView] = useQueryState(
    'view',
    parseAsStringLiteral(['current', 'log'] as const).withDefault('current'),
  );
  const [adding, setAdding] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [revoking, setRevoking] = React.useState<CurrentSuppression | null>(null);
  const filters = {
    q: q || undefined,
    scope: scope === ALL ? undefined : scope,
    reason: reason === ALL ? undefined : reason,
    view,
  };
  const list = useSuppressions(filters);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="supp-q">{t('search')}</Label>
          <Input
            id="supp-q"
            value={q}
            onChange={(event) => void setQ(event.target.value || null)}
            className="w-60"
          />
        </div>
        <FilterSelect
          id="supp-scope"
          label={t('scope')}
          value={scope}
          onChange={(value) => void setScope(value)}
          options={[[ALL, t('all')], ...SUPPRESSION_SCOPES.map((s) => [s, scopeName(s)] as [string, string])]}
        />
        <FilterSelect
          id="supp-reason"
          label={t('reason')}
          value={reason}
          onChange={(value) => void setReason(value)}
          options={[
            [ALL, t('all')],
            ...SUPPRESSION_REASONS.map((r) => [r, reasonName(r)] as [string, string]),
          ]}
        />
        <FilterSelect
          id="supp-view"
          label={t('view')}
          value={view}
          onChange={(value) => void setView(value as 'current' | 'log')}
          options={[
            ['current', t('current')],
            ['log', t('log')],
          ]}
        />
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setAdding(true)}>
            <PlusIcon aria-hidden />
            {t('add')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setImporting(true)}>
            <UploadIcon aria-hidden />
            {t('import')}
          </Button>
          {canExport ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                downloadFromApi(
                  '/v1/suppressions/export.csv',
                  Object.fromEntries(
                    Object.entries(filters).filter(([key, value]) => key !== 'view' && value),
                  ) as Record<string, string>,
                )
              }
            >
              <DownloadIcon aria-hidden />
              {t('export')}
            </Button>
          ) : null}
        </div>
      </div>
      {list.isError ? (
        <ErrorState
          problem={toProblemLike(list.error, t('loadError'))}
          labels={errorLabels}
          onRetry={() => void list.refetch()}
        />
      ) : !list.data ? (
        <Skeleton className="h-48 w-full" />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<BanIcon aria-hidden />} title={t('emptyTitle')} description={t('emptyBody')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('caption')}</caption>
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-normal">
                  {t('value')}
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  {t('scope')}
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  {t('reason')}
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  {t('source')}
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  {t('when')}
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  <span className="sr-only">{t('actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.view === 'current'
                ? list.data.items.map((row) => (
                    <tr key={row.entryId} className="border-t">
                      <td className="px-3 py-2 font-mono text-xs">
                        {row.scope === 'email_hash' ? t('hashed') : row.value}
                      </td>
                      <td className="px-3 py-2">{scopeName(row.scope)}</td>
                      <td className="px-3 py-2">{reasonName(row.reason)}</td>
                      <td className="px-3 py-2">{t(`sources.${row.source}`)}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {format.dateTime(new Date(row.createdAt), { dateStyle: 'medium' })}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {row.global ? (
                          <Badge variant="secondary">{t('global')}</Badge>
                        ) : canRevoke ? (
                          <Button size="sm" variant="ghost" onClick={() => setRevoking(row)}>
                            {t('revoke')}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))
                : list.data.items.map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="px-3 py-2 font-mono text-xs">
                        {row.scope === 'email_hash' ? t('hashed') : row.value}{' '}
                        <Badge variant={row.action === 'add' ? 'outline' : 'secondary'}>
                          {t(`action.${row.action}`)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">{scopeName(row.scope)}</td>
                      <td className="px-3 py-2">{reasonName(row.reason)}</td>
                      <td className="px-3 py-2">{t(`sources.${row.source}`)}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {format.dateTime(new Date(row.createdAt), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </td>
                      <td />
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}
      <AddDialog open={adding} onOpenChange={setAdding} />
      <ImportDialog open={importing} onOpenChange={setImporting} />
      <RevokeDialog entry={revoking} onClose={() => setRevoking(null)} />
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly (readonly [string, string])[];
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([key, name]) => (
            <SelectItem key={key} value={key}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const EDITABLE_SCOPES: SuppressionScope[] = ['email', 'domain', 'phone'];

function AddDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('complianceAdmin.suppressions');
  const scopeName = useTranslations('complianceAdmin.scopes');
  const { add } = useSuppressionActions();
  const [scope, setScope] = React.useState<SuppressionScope>('email');
  const [value, setValue] = React.useState('');
  const [note, setNote] = React.useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const toast = await getToast();
    try {
      await add.mutateAsync({ scope, value, ...(note ? { note } : {}) });
      toast.success(t('added'));
      setValue('');
      setNote('');
      onOpenChange(false);
    } catch (error) {
      toast.error(toProblemLike(error, t('failed')).title);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('addTitle')}</DialogTitle>
          <DialogDescription>{t('addHint')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(event) => void submit(event)}>
          <div className="space-y-1">
            <Label htmlFor="add-scope">{t('scope')}</Label>
            <Select value={scope} onValueChange={(next) => setScope(next as SuppressionScope)}>
              <SelectTrigger id="add-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EDITABLE_SCOPES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {scopeName(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="add-value">{t('value')}</Label>
            <Input
              id="add-value"
              required
              maxLength={320}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="add-note">{t('note')}</Label>
            <Input
              id="add-note"
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={add.isPending}>
              {t('add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('complianceAdmin.suppressions');
  const scopeName = useTranslations('complianceAdmin.scopes');
  const { import: run } = useSuppressionActions();
  const [csv, setCsv] = React.useState('');
  const [scope, setScope] = React.useState<SuppressionScope>('email');
  const [preview, setPreview] = React.useState<Awaited<ReturnType<typeof run.mutateAsync>> | null>(null);
  const go = async (dryRun: boolean) => {
    const toast = await getToast();
    try {
      const result = await run.mutateAsync({ csv, scope, dryRun });
      if (dryRun) setPreview(result);
      else {
        toast.success(t('imported', { added: result.added }));
        setPreview(null);
        setCsv('');
        onOpenChange(false);
      }
    } catch (error) {
      toast.error(toProblemLike(error, t('failed')).title);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('importTitle')}</DialogTitle>
          <DialogDescription>{t('importHint')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="import-file">{t('file')}</Label>
            <Input
              id="import-file"
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file)
                  void file.text().then((text) => {
                    setCsv(text);
                    setPreview(null);
                  });
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="import-text">{t('orPaste')}</Label>
            <Textarea
              id="import-text"
              rows={5}
              value={csv}
              onChange={(event) => {
                setCsv(event.target.value);
                setPreview(null);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="import-scope">{t('scope')}</Label>
            <Select
              value={scope}
              onValueChange={(next) => {
                setScope(next as SuppressionScope);
                setPreview(null);
              }}
            >
              <SelectTrigger id="import-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EDITABLE_SCOPES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {scopeName(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {preview ? (
            <div role="status" className="rounded-md bg-muted/60 p-3 text-sm">
              <p>
                {t('previewSummary', {
                  rows: preview.rows,
                  valid: preview.valid,
                  duplicates: preview.duplicates,
                  already: preview.alreadySuppressed,
                  invalid: preview.invalidCount,
                })}
              </p>
              {preview.invalid.length > 0 ? (
                <ul className="mt-2 list-disc pl-5 text-xs text-destructive">
                  {preview.invalid.slice(0, 5).map((row) => (
                    <li key={row.line}>{t('invalidLine', { line: row.line, value: row.value })}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={!csv || run.isPending} onClick={() => void go(true)}>
            {t('preview')}
          </Button>
          <Button
            disabled={!preview || preview.valid - preview.alreadySuppressed === 0 || run.isPending}
            onClick={() => void go(false)}
          >
            {t('commit', { count: preview ? preview.valid - preview.alreadySuppressed : 0 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({
  entry,
  onClose,
}: {
  readonly entry: CurrentSuppression | null;
  readonly onClose: () => void;
}) {
  const t = useTranslations('complianceAdmin.suppressions');
  const { revoke } = useSuppressionActions();
  const [note, setNote] = React.useState('');
  const [consent, setConsent] = React.useState('');
  const needsConsent = entry?.reason === 'unsubscribe' || entry?.reason === 'opt_out';
  const submit = async () => {
    if (!entry) return;
    const toast = await getToast();
    try {
      await revoke.mutateAsync({
        id: entry.entryId,
        note,
        ...(needsConsent ? { consentEvidence: consent } : {}),
      });
      toast.success(t('revoked'));
      setNote('');
      setConsent('');
      onClose();
    } catch (error) {
      toast.error(toProblemLike(error, t('failed')).title);
    }
  };
  return (
    <Dialog open={entry !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('revokeTitle')}</DialogTitle>
          <DialogDescription>{entry?.value}</DialogDescription>
        </DialogHeader>
        {needsConsent ? (
          <p
            role="alert"
            className="rounded-md border border-amber-400 bg-amber-50 p-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50"
          >
            {t('consentWarning')}
          </p>
        ) : null}
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="revoke-note">{t('revokeReason')}</Label>
            <Input
              id="revoke-note"
              minLength={3}
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {needsConsent ? (
            <div className="space-y-1">
              <Label htmlFor="revoke-consent">{t('consentEvidence')}</Label>
              <Textarea
                id="revoke-consent"
                rows={3}
                maxLength={1000}
                value={consent}
                onChange={(event) => setConsent(event.target.value)}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={
              note.trim().length < 3 || (needsConsent && consent.trim().length < 10) || revoke.isPending
            }
            onClick={() => void submit()}
          >
            {t('revoke')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
