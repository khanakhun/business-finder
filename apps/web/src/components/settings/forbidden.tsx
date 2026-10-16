import { EmptyState } from '@bf/ui/components/empty-state';
import { LockIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** Shown when the role lacks the permission for a settings section (the API refuses it as well). */
export function Forbidden() {
  const t = useTranslations('forbidden');
  return <EmptyState icon={<LockIcon aria-hidden />} title={t('title')} description={t('body')} />;
}
