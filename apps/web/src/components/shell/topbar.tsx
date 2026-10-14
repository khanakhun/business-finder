'use client';

import { Button } from '@bf/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@bf/ui/components/dropdown-menu';
import { KeyboardShortcut } from '@bf/ui/components/keyboard-shortcut';
import { Popover, PopoverContent, PopoverTrigger } from '@bf/ui/components/popover';
import { BellIcon, ChevronsUpDownIcon, MenuIcon, SearchIcon, UserIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { activeNavItem } from '@/lib/navigation.ts';
import { LanguageMenu, ThemeMenu } from './preferences.tsx';

export interface TopbarProps {
  readonly onOpenPalette: () => void;
  readonly onOpenMobileNav: () => void;
}

export function Topbar({ onOpenPalette, onOpenMobileNav }: TopbarProps) {
  const t = useTranslations();
  const current = activeNavItem(usePathname());

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur sm:px-5">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onOpenMobileNav}
        aria-label={t('topbar.openMenu')}
      >
        <MenuIcon aria-hidden />
      </Button>

      {/* Workspace switcher: real workspaces arrive with BF-010. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 font-medium"
            aria-label={t('topbar.switchWorkspace')}
          >
            {t('topbar.workspace')}
            <ChevronsUpDownIcon aria-hidden className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem disabled>{t('topbar.workspace')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {current ? (
        <p className="hidden truncate text-muted-foreground sm:block">
          <span aria-hidden className="mr-2 text-line-strong">
            /
          </span>
          {t(`nav.${current.key}`)}
        </p>
      ) : null}

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={onOpenPalette}
          className="hidden h-8 min-w-64 items-center gap-2 whitespace-nowrap rounded-md border bg-surface px-2.5 text-sm text-muted-foreground hover:border-line-strong md:flex"
        >
          <SearchIcon aria-hidden className="size-4" />
          <span className="flex-1 text-left">{t('topbar.commandPalette')}</span>
          <KeyboardShortcut keys={['mod', 'k']} />
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onOpenPalette}
          aria-label={t('topbar.commandPalette')}
        >
          <SearchIcon aria-hidden />
        </Button>
        {/* On phones these live in Settings and the command palette, so the bar never overflows. */}
        <div className="hidden items-center gap-1 sm:flex">
          <LanguageMenu />
          <ThemeMenu />
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('topbar.notifications')}
              className="text-muted-foreground"
            >
              <BellIcon aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 text-sm text-muted-foreground">
            {t('topbar.noNotifications')}
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('topbar.account')}
              className="text-muted-foreground"
            >
              <UserIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('topbar.account')}</DropdownMenuLabel>
            <DropdownMenuItem disabled>{t('topbar.signedOut')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
