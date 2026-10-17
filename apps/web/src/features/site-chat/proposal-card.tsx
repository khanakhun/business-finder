'use client';

import type { SiteChangeProposal } from '@bf/contracts';
import { apply, OperationSchema, type SiteSpec } from '@bf/site-schema';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import { Label } from '@bf/ui/components/label';
import { CheckIcon, EyeIcon, EyeOffIcon, RotateCcwIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { useSiteEditorActions } from '@/features/site-editor/context.tsx';
import { getToast } from '@/lib/toast.tsx';
import { applyProposal, discardProposal, undoProposal } from './api.ts';

// A proposal of the edit agent (BF-047): what changes (from its diff), what to watch (warnings), the facts to confirm,
// and Preview (the proposed site on the canvas, before/after), Apply (one new version), Discard; once applied, Undo.

interface DiffView {
  readonly pages?: { readonly added?: string[]; readonly removed?: string[] };
  readonly blocks?: {
    readonly added?: { pageId: string; blockId: string; type: string }[];
    readonly removed?: { pageId: string; blockId: string; type: string }[];
    readonly moved?: { pageId: string; blockId: string; type: string }[];
    readonly changed?: { pageId: string; blockId: string; type: string; fields: string[] }[];
  };
  readonly texts?: { locale: string; before: string | null; after: string | null }[];
  readonly sections?: string[];
}

/** The proposed site, from the base spec (null when the operations do not apply to it). */
export function proposedSpec(base: SiteSpec, proposal: SiteChangeProposal): SiteSpec | null {
  const parsed = OperationSchema.safeParse(
    proposal.operations.length === 1 ? proposal.operations[0] : { op: 'batch', ops: proposal.operations },
  );
  if (!parsed.success) return null;
  try {
    return apply(base, parsed.data).spec;
  } catch {
    return null;
  }
}

export function ProposalCard({
  proposal,
  onChanged,
}: {
  readonly proposal: SiteChangeProposal;
  readonly onChanged: () => void;
}) {
  const t = useTranslations('siteChat.proposal');
  const { chat } = useSiteEditorActions();
  const [confirmed, setConfirmed] = React.useState<Set<string>>(() => new Set());
  const [previewing, setPreviewing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [appliedVersion, setAppliedVersion] = React.useState<{ id: string; number: number } | null>(null);
  const diff = proposal.diff as DiffView;
  const open = proposal.status === 'proposed';
  const onBase = proposal.baseVersionId === chat.baseVersionId;
  React.useEffect(() => () => chat.preview(null), [chat.preview]);

  const toggle = (id: string, on: boolean) =>
    setConfirmed((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      (await getToast()).error(toProblemLike(error, t('failed')).title ?? t('failed'));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const preview = () => {
    if (previewing) {
      chat.preview(null);
      setPreviewing(false);
      return;
    }
    const spec = proposedSpec(chat.baseSpec, proposal);
    if (!spec) {
      void getToast().then((toast) => toast.error(t('previewFailed')));
      return;
    }
    chat.preview(spec, t('previewBanner'));
    setPreviewing(true);
  };
  const changes = [
    ...(diff.pages?.added ?? []).map((page) => t('changes.pageAdded', { page })),
    ...(diff.pages?.removed ?? []).map((page) => t('changes.pageRemoved', { page })),
    ...(diff.blocks?.added ?? []).map((block) =>
      t('changes.blockAdded', { type: block.type, page: block.pageId }),
    ),
    ...(diff.blocks?.removed ?? []).map((block) =>
      t('changes.blockRemoved', { type: block.type, page: block.pageId }),
    ),
    ...(diff.blocks?.moved ?? []).map((block) =>
      t('changes.blockMoved', { type: block.type, page: block.pageId }),
    ),
    ...(diff.blocks?.changed ?? []).map((block) =>
      t('changes.blockChanged', {
        type: block.type,
        page: block.pageId,
        fields: block.fields.slice(0, 4).join(', '),
      }),
    ),
    ...(diff.sections ?? []).map((section) => t('changes.section', { section })),
  ];
  return (
    <article className="space-y-2 rounded-lg border bg-card p-3 text-sm" aria-label={t('label')}>
      <header className="flex flex-wrap items-center gap-2">
        <Badge variant={open ? 'default' : 'secondary'}>{t(`status.${proposal.status}`)}</Badge>
        {!onBase && open ? <Badge variant="outline">{t('olderVersion')}</Badge> : null}
      </header>
      <p>{proposal.summary}</p>
      {changes.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-xs">
          {changes.slice(0, 12).map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      ) : null}
      {(diff.texts ?? []).slice(0, 4).map((text, index) => (
        <p key={`${text.locale}-${index}`} className="text-xs">
          <span className="font-mono uppercase text-muted-foreground">{text.locale}</span>{' '}
          {text.before ? <del className="text-muted-foreground">{text.before}</del> : null}
          {text.before && text.after ? ' → ' : null}
          {text.after ? <ins className="no-underline">{text.after}</ins> : null}
        </p>
      ))}
      {proposal.issues.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-amber-800 dark:text-amber-200">
          {proposal.issues.slice(0, 5).map((issue, index) => (
            <li key={`${issue.code}-${index}`} className="flex gap-1">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {proposal.factsToAssert.length > 0 && open ? (
        <fieldset className="space-y-1 rounded-md bg-muted/50 p-2">
          <legend className="text-xs font-medium">{t('facts')}</legend>
          {proposal.factsToAssert.map((fact) => (
            <Label key={fact.id} className="flex items-start gap-2 text-xs font-normal">
              <Checkbox
                checked={confirmed.has(fact.id)}
                onCheckedChange={(on) => toggle(fact.id, on === true)}
              />
              <span>
                <span className="font-medium">{fact.kind}</span>:{' '}
                {typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value)}
              </span>
            </Label>
          ))}
        </fieldset>
      ) : null}
      {proposal.statusReason ? (
        <p className="text-xs text-muted-foreground">{proposal.statusReason}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {open ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!onBase}
              onClick={preview}
              aria-pressed={previewing}
            >
              {previewing ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
              {previewing ? t('before') : t('preview')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || chat.dirty}
              title={chat.dirty ? t('saveFirst') : undefined}
              onClick={() =>
                void run(async () => {
                  chat.preview(null);
                  setPreviewing(false);
                  const result = await applyProposal(chat.siteId, proposal.id, [...confirmed]);
                  await chat.adopt(result.versionId);
                  setAppliedVersion({ id: result.versionId, number: result.versionNumber });
                  (await getToast()).success(t('applied', { version: result.versionNumber }));
                })
              }
            >
              <CheckIcon aria-hidden />
              {t('apply')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  chat.preview(null);
                  await discardProposal(chat.siteId, proposal.id);
                })
              }
            >
              <XIcon aria-hidden />
              {t('discard')}
            </Button>
          </>
        ) : null}
        {proposal.status === 'applied' && proposal.appliedVersionId === chat.baseVersionId ? (
          <>
            {appliedVersion ? (
              <Badge variant="outline">{t('version', { version: appliedVersion.number })}</Badge>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || chat.dirty}
              onClick={() =>
                void run(async () => {
                  const restored = await undoProposal(
                    chat.siteId,
                    proposal.baseVersionId,
                    chat.baseVersionId,
                  );
                  await chat.adopt(restored.id);
                  (await getToast()).success(t('undone'));
                })
              }
            >
              <RotateCcwIcon aria-hidden />
              {t('undo')}
            </Button>
          </>
        ) : null}
      </div>
      {chat.dirty && open ? <p className="text-xs text-muted-foreground">{t('saveFirst')}</p> : null}
    </article>
  );
}
