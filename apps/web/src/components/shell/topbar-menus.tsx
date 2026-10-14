'use client';

import { Button } from '@bf/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@bf/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@bf/ui/components/popover';
import { BellIcon, ChevronsUpDownIcon, UserIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { LanguageMenu as LanguageMenuBase, ThemeMenu as ThemeMenuBase } from './preferences.tsx';

// The real top-bar menus, loaded by LazyMenu on first intent. Triggers match the placeholders exactly.

export function WorkspaceMenu({ defaultOpen }: { readonly defaultOpen: boolean }) {
  const t = useTranslations('topbar');
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 font-medium" aria-label={t('switchWorkspace')}>
          {t('workspace')}
          <ChevronsUpDownIcon aria-hidden className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem disabled>{t('workspace')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function NotificationsMenu({ defaultOpen }: { readonly defaultOpen: boolean }) {
  const t = useTranslations('topbar');
  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('notifications')} className="text-muted-foreground">
          <BellIcon aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 text-sm text-muted-foreground">
        {t('noNotifications')}
      </PopoverContent>
    </Popover>
  );
}

export function AccountMenu({ defaultOpen }: { readonly defaultOpen: boolean }) {
  const t = useTranslations('topbar');
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('account')} className="text-muted-foreground">
          <UserIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('account')}</DropdownMenuLabel>
        <DropdownMenuItem disabled>{t('signedOut')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LanguageMenu({ defaultOpen }: { readonly defaultOpen: boolean }) {
  return <LanguageMenuBase defaultOpen={defaultOpen} />;
}

export function ThemeMenu({ defaultOpen }: { readonly defaultOpen: boolean }) {
  return <ThemeMenuBase defaultOpen={defaultOpen} />;
}
