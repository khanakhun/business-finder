'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { KeyboardShortcut } from '@bf/ui/components/keyboard-shortcut';
import { useTranslations } from 'next-intl';

export const SHORTCUTS = [
  { keys: ['mod', 'k'], label: 'openPalette' },
  { keys: ['?'], label: 'showShortcuts' },
  { keys: ['mod', 'b'], label: 'toggleSidebar' },
] as const;

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('shortcuts');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <dl className="divide-y">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.label} className="flex items-center justify-between py-2.5">
              <dt>{t(shortcut.label)}</dt>
              <dd>
                <KeyboardShortcut keys={shortcut.keys} />
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
