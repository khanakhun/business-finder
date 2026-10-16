'use client';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@bf/ui/components/command';
import { KeyboardShortcut } from '@bf/ui/components/keyboard-shortcut';
import { useTranslations } from 'next-intl';
import type { Command } from '@/lib/commands.tsx';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly commands: readonly Command[];
}

/** ⌘K / Ctrl+K: every command, grouped, searchable by label and keywords. */
export function CommandPalette({ open, onOpenChange, commands }: CommandPaletteProps) {
  const t = useTranslations('commands');
  const groups = [...new Set(commands.map((c) => c.group))];
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t('title')} description={t('placeholder')}>
      <CommandInput placeholder={t('placeholder')} />
      <CommandList>
        <CommandEmpty>{t('empty')}</CommandEmpty>
        {groups.map((group) => (
          <CommandGroup key={group} heading={group}>
            {commands
              .filter((c) => c.group === group)
              .map((command) => (
                <CommandItem
                  key={command.id}
                  value={`${command.label} ${command.keywords?.join(' ') ?? ''}`}
                  onSelect={() => {
                    onOpenChange(false);
                    command.run();
                  }}
                >
                  {command.icon}
                  <span>{command.label}</span>
                  {command.shortcut ? (
                    <CommandShortcut>
                      <KeyboardShortcut keys={command.shortcut} />
                    </CommandShortcut>
                  ) : null}
                </CommandItem>
              ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
