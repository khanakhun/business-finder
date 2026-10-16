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

/** The editor's keyboard shortcuts (`?`): its own and Puck's canvas history. */
const SHORTCUTS = [
  { keys: ['mod', 's'], label: 'save' },
  { keys: ['mod', 'z'], label: 'undo' },
  { keys: ['mod', 'shift', 'z'], label: 'redo' },
  { keys: ['?'], label: 'help' },
  { keys: ['Esc'], label: 'close' },
] as const;

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('siteEditor.shortcuts');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
          {SHORTCUTS.map(({ keys, label }) => (
            <div key={label} className="contents">
              <dt>{t(label)}</dt>
              <dd>
                <KeyboardShortcut keys={keys} />
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
