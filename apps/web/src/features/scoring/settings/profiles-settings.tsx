'use client';

import type { ScoringProfileSummary } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { Button } from '@bf/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@bf/ui/components/dropdown-menu';
import { ErrorState } from '@bf/ui/components/error-state';
import { Skeleton } from '@bf/ui/components/skeleton';
import { MoreHorizontalIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { SettingsSection } from '@/components/settings/section.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useCreateProfile, useScoringProfiles, useSetPrimaryProfile, useUpdateProfile } from '../api.ts';
import { OFFER_ICON } from '../score-badge.tsx';
import { NameDialog } from './name-dialog.tsx';

// Settings → Scoring (BF-032): the profiles the workspace scores with — built-in ones (read-only) and its own
// (duplicated from one it sees). Editing needs `scoring:manage`; everyone else reads.

type Dialog = { readonly kind: 'duplicate' | 'rename'; readonly profile: ScoringProfileSummary } | null;

export function ProfilesSettings() {
  const t = useTranslations('scoringSettings');
  const offers = useTranslations('scoring.offers');
  const labels = useErrorLabels();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const canManage = usePermission('scoring:manage');
  const profiles = useScoringProfiles();
  const create = useCreateProfile();
  const update = useUpdateProfile();
  const primary = useSetPrimaryProfile();
  const [dialog, setDialog] = React.useState<Dialog>(null);

  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      (await getToast()).success(success);
    } catch (caught) {
      (await getToast()).error(errorMessage(caught));
    }
  };

  if (profiles.isPending) return <Skeleton className="h-64 w-full max-w-3xl" />;
  if (profiles.isError) {
    return (
      <ErrorState
        problem={toProblemLike(profiles.error, t('loadFailed'))}
        labels={labels}
        onRetry={() => void profiles.refetch()}
      />
    );
  }
  const items = profiles.data.items;
  const groups = [
    { id: 'own', title: t('own'), description: t('ownDescription'), items: items.filter((p) => !p.builtin) },
    {
      id: 'builtin',
      title: t('builtin'),
      description: t('builtinDescription'),
      items: items.filter((p) => p.builtin),
    },
  ];
  return (
    <div className="grid gap-6">
      {groups.map((group) => (
        <SettingsSection
          key={group.id}
          id={`profiles-${group.id}`}
          title={group.title}
          description={group.description}
        >
          {group.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noOwn')}</p>
          ) : (
            <ul className="divide-y" aria-labelledby={`profiles-${group.id}`}>
              {group.items.map((profile) => {
                const Icon = OFFER_ICON[profile.offer];
                return (
                  <li
                    key={profile.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                    data-testid={`profile-${profile.id}`}
                  >
                    <div className="grid gap-1">
                      <Link
                        href={`/settings/scoring/${profile.id}`}
                        className="flex items-center gap-2 font-medium hover:underline"
                      >
                        <Icon aria-hidden className="size-4" />
                        {profile.name}
                      </Link>
                      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        {offers(profile.offer)}
                        {profile.activeVersion ? (
                          <span>{t('activeVersion', { version: profile.activeVersion })}</span>
                        ) : null}
                        {profile.primary ? <Badge variant="secondary">{t('primary')}</Badge> : null}
                        {profile.archived ? <Badge variant="outline">{t('archived')}</Badge> : null}
                      </p>
                    </div>
                    {canManage ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('actionsFor', { name: profile.name })}
                          >
                            <MoreHorizontalIcon aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/settings/scoring/${profile.id}`}>
                              {profile.builtin ? t('view') : t('edit')}
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setDialog({ kind: 'duplicate', profile })}>
                            {t('duplicate')}
                          </DropdownMenuItem>
                          {!profile.primary && !profile.archived ? (
                            <DropdownMenuItem
                              onSelect={() =>
                                void run(
                                  () => primary.mutateAsync(profile.id),
                                  t('primaryChanged', { name: profile.name }),
                                )
                              }
                            >
                              {t('makePrimary')}
                            </DropdownMenuItem>
                          ) : null}
                          {!profile.builtin ? (
                            <>
                              <DropdownMenuItem onSelect={() => setDialog({ kind: 'rename', profile })}>
                                {t('rename')}
                              </DropdownMenuItem>
                              {!profile.primary ? (
                                <DropdownMenuItem
                                  onSelect={() =>
                                    void run(
                                      () =>
                                        update.mutateAsync({ id: profile.id, archived: !profile.archived }),
                                      t(profile.archived ? 'unarchived' : 'archivedDone', {
                                        name: profile.name,
                                      }),
                                    )
                                  }
                                >
                                  {profile.archived ? t('unarchive') : t('archive')}
                                </DropdownMenuItem>
                              ) : null}
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </SettingsSection>
      ))}
      <NameDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={dialog?.kind === 'rename' ? t('renameTitle') : t('duplicateTitle')}
        {...(dialog?.kind === 'duplicate' ? { description: t('duplicateDescription') } : {})}
        initial={
          dialog?.kind === 'rename'
            ? dialog.profile.name
            : dialog
              ? t('copyOf', { name: dialog.profile.name })
              : ''
        }
        submitLabel={dialog?.kind === 'rename' ? t('save') : t('duplicate')}
        onSubmit={async (name) => {
          if (!dialog) return;
          if (dialog.kind === 'rename') {
            await update.mutateAsync({ id: dialog.profile.id, name });
            (await getToast()).success(t('renamed'));
            return;
          }
          const created = await create.mutateAsync({ fromProfileId: dialog.profile.id, name });
          (await getToast()).success(t('duplicated', { name }));
          router.push(`/settings/scoring/${created.id}`);
        }}
      />
    </div>
  );
}
