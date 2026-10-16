import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { PageHeader } from '@bf/ui/components/page-header';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function NotFound() {
  const t = await getTranslations('errors');
  return (
    <>
      <PageHeader title={t('notFoundTitle')} />
      <EmptyState
        title={t('notFoundTitle')}
        description={t('notFoundDescription')}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/">{t('backHome')}</Link>
          </Button>
        }
      />
    </>
  );
}
