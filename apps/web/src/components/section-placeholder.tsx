'use client';

import { Button } from '@bf/ui/components/button';
import { EmptyState } from '@bf/ui/components/empty-state';
import { PageHeader } from '@bf/ui/components/page-header';
import { useTranslations } from 'next-intl';
import { NAV_ITEMS, type NavKey } from '@/lib/navigation.ts';

/** Stand-in for sections whose feature tickets have not landed yet, so navigation is complete from day one. */
export function SectionPlaceholder({ section }: { readonly section: NavKey }) {
  const t = useTranslations();
  const item = NAV_ITEMS.find((i) => i.key === section);
  const name = t(`nav.${section}`);
  const openPalette = () =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }),
    );
  return (
    <>
      <PageHeader title={name} />
      <EmptyState
        icon={item ? <item.icon /> : null}
        title={t('placeholder.title', { section: name })}
        description={t('placeholder.description')}
        action={
          <Button variant="outline" size="sm" onClick={openPalette}>
            {t('placeholder.openPalette')}
          </Button>
        }
      />
    </>
  );
}
