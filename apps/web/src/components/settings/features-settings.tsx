'use client';

import { FEATURE_FLAG_NAMES, type FeatureFlag, type OrgSettings } from '@bf/contracts';
import { Badge } from '@bf/ui/components/badge';
import { ErrorState } from '@bf/ui/components/error-state';
import { Label } from '@bf/ui/components/label';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Switch } from '@bf/ui/components/switch';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useErrorMessage } from '@/components/auth/fields.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { Forbidden } from './forbidden.tsx';
import { SettingsSection } from './section.tsx';
import { useWorkspaceSettings } from './workspace-settings.tsx';

export function FeaturesSettings() {
  const t = useTranslations();
  const canManage = usePermission('settings:manage');
  const labels = useErrorLabels();
  const errorMessage = useErrorMessage();
  const client = useQueryClient();
  const query = useWorkspaceSettings(canManage);
  const toggle = useMutation({
    mutationFn: async ({ flag, value }: { flag: FeatureFlag; value: boolean }) =>
      (await apiClient().PATCH('/v1/workspace/settings', { body: { features: { [flag]: value } } })).data,
    onSuccess: async (saved) => {
      client.setQueryData(queryKeys.workspace.settings(), saved);
      (await getToast()).success(t('features.saved'));
    },
    onError: async (caught) => (await getToast()).error(errorMessage(caught)),
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
  const settings: OrgSettings | undefined = query.data;
  return (
    <SettingsSection id="features" title={t('features.title')}>
      {settings ? (
        <ul className="grid gap-4">
          {FEATURE_FLAG_NAMES.map((flag) => {
            const state = settings.features[flag];
            const id = `feature-${flag}`;
            return (
              <li key={flag} className="flex items-start justify-between gap-4">
                <div className="grid gap-0.5">
                  <Label htmlFor={id}>{t(`features.flags.${flag}.label`)}</Label>
                  <p id={`${id}-description`} className="text-sm text-muted-foreground">
                    {t(`features.flags.${flag}.description`)}
                  </p>
                  {state && !state.available ? (
                    <Badge variant="outline" className="mt-1 w-fit">
                      {t('features.unavailable')}
                    </Badge>
                  ) : null}
                </div>
                <Switch
                  id={id}
                  aria-describedby={`${id}-description`}
                  checked={state?.enabled ?? false}
                  disabled={!state?.available || toggle.isPending}
                  onCheckedChange={(value) => toggle.mutate({ flag, value })}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <Skeleton className="h-40" />
      )}
    </SettingsSection>
  );
}
