'use client';

import { Sheet, SheetContent, SheetTitle } from '@bf/ui/components/sheet';
import { useTranslations } from 'next-intl';
import { Sidebar } from './sidebar.tsx';

/** Navigation drawer for small screens (loaded on first open). */
export function MobileNav({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('nav');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-64 p-0">
        <SheetTitle className="sr-only">{t('label')}</SheetTitle>
        <Sidebar collapsed={false} onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
