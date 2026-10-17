'use client';

import type { LawfulBasisRecord, UpsertLawfulBasisRequest } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { ErrorState } from '@bf/ui/components/error-state';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Textarea } from '@bf/ui/components/textarea';
import { FileTextIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useLawfulBasis, useLawfulBasisActions } from './api.ts';

// Settings → Compliance → Lawful basis (BF-049): legitimate-interest assessments started from the template, edited
// while draft, approved (which the gate requires for legitimate-interest outreach) and retired.

const FIELDS = [
  'purpose',
  'dataCategories',
  'necessity',
  'balancingTest',
  'safeguards',
  'retention',
] as const;
type Field = (typeof FIELDS)[number];

export function LiaEditor() {
  const t = useTranslations('compliance.lia');
  const errorLabels = useErrorLabels();
  const records = useLawfulBasis();
  const actions = useLawfulBasisActions();
  const canManage = usePermission('compliance:manage');
  const [selected, setSelected] = React.useState<string | null>(null);
  const create = async () => {
    const toast = await getToast();
    try {
      const record = await actions.fromTemplate.mutateAsync();
      setSelected(record.id);
    } catch (error) {
      toast.error(toProblemLike(error, t('saveError')).title ?? t('saveError'));
    }
  };
  if (records.isError)
    return (
      <ErrorState
        problem={toProblemLike(records.error, t('loadError'))}
        labels={errorLabels}
        onRetry={() => void records.refetch()}
      />
    );
  if (!records.data) return <Skeleton className="h-40 w-full" />;
  const current = records.data.find((record) => record.id === selected) ?? null;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('hint')}</p>
        {canManage ? (
          <Button
            type="button"
            size="sm"
            disabled={actions.fromTemplate.isPending}
            onClick={() => void create()}
          >
            {t('fromTemplate')}
          </Button>
        ) : null}
      </div>
      {records.data.length === 0 ? (
        <EmptyState
          icon={<FileTextIcon aria-hidden />}
          title={t('emptyTitle')}
          description={t('emptyBody')}
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {records.data.map((record) => (
            <li key={record.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/60"
                aria-pressed={record.id === selected}
                onClick={() => setSelected(record.id === selected ? null : record.id)}
              >
                <span className="font-medium">{record.title}</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {t('version', { version: record.version })}
                  <Badge variant={record.status === 'approved' ? 'default' : 'outline'}>
                    {t(`status.${record.status}`)}
                  </Badge>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {current ? (
        <RecordForm key={`${current.id}-${current.updatedAt}`} record={current} canManage={canManage} />
      ) : null}
    </div>
  );
}

function RecordForm({
  record,
  canManage,
}: {
  readonly record: LawfulBasisRecord;
  readonly canManage: boolean;
}) {
  const t = useTranslations('compliance.lia');
  const format = useFormatter();
  const actions = useLawfulBasisActions();
  const editable = canManage && record.status === 'draft';
  const [values, setValues] = React.useState<Record<Field | 'title', string>>(() => ({
    title: record.title,
    purpose: record.purpose,
    dataCategories: record.dataCategories,
    necessity: record.necessity,
    balancingTest: record.balancingTest,
    safeguards: record.safeguards,
    retention: record.retention,
  }));
  const run = async (action: () => Promise<unknown>, done: string) => {
    const toast = await getToast();
    try {
      await action();
      toast.success(done);
    } catch (error) {
      toast.error(toProblemLike(error, t('saveError')).title ?? t('saveError'));
    }
  };
  const body: UpsertLawfulBasisRequest = { kind: record.kind, documentMd: record.documentMd, ...values };
  return (
    <form
      className="space-y-3 rounded-lg border p-4 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => actions.update.mutateAsync({ id: record.id, body }), t('saved'));
      }}
    >
      {record.approvedAt ? (
        <p className="text-xs text-muted-foreground">
          {t('approvedBy', {
            name: record.approvedBy ?? '',
            when: format.dateTime(new Date(record.approvedAt), { dateStyle: 'medium' }),
          })}
        </p>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor="lia-title">{t('fields.title')}</Label>
        <Input
          id="lia-title"
          value={values.title}
          readOnly={!editable}
          maxLength={200}
          onChange={(event) => setValues({ ...values, title: event.target.value })}
        />
      </div>
      {FIELDS.map((field) => (
        <div key={field} className="space-y-1">
          <Label htmlFor={`lia-${field}`}>{t(`fields.${field}`)}</Label>
          <Textarea
            id={`lia-${field}`}
            rows={field === 'balancingTest' ? 6 : 3}
            value={values[field]}
            readOnly={!editable}
            onChange={(event) => setValues({ ...values, [field]: event.target.value })}
          />
        </div>
      ))}
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {editable ? (
            <>
              <Button type="submit" size="sm" variant="outline" disabled={actions.update.isPending}>
                {t('save')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={actions.approve.isPending}
                onClick={() => void run(() => actions.approve.mutateAsync(record.id), t('approved'))}
              >
                {t('approve')}
              </Button>
            </>
          ) : null}
          {record.status !== 'retired' ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={actions.retire.isPending}
              onClick={() => void run(() => actions.retire.mutateAsync(record.id), t('retired'))}
            >
              {t('retire')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
