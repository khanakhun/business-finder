'use client';

import { Button } from '@bf/ui/components/button';
import { KeyboardShortcut } from '@bf/ui/components/keyboard-shortcut';
import {
  BellIcon,
  ChevronsUpDownIcon,
  LanguagesIcon,
  MenuIcon,
  MoonIcon,
  SearchIcon,
  SunIcon,
  UserIcon,
} from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { activeNavItem } from '@/lib/navigation.ts';
import { useSession } from '@/lib/session.tsx';
import { LazyMenu } from './lazy-menu.tsx';

const menus = () => import('./topbar-menus.tsx');

export interface TopbarProps {
  readonly onOpenPalette: () => void;
  readonly onOpenMobileNav: () => void;
  /** Hover/focus on the search button: start loading the palette before it is opened. */
  readonly onPalettePrefetch: () => void;
}

export function Topbar({ onOpenPalette, onOpenMobileNav, onPalettePrefetch }: TopbarProps) {
  const t = useTranslations();
  const locale = useLocale();
  const current = activeNavItem(usePathname());
  const workspaceName = useSession().activeOrganization?.name ?? t('workspace.none');

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

      <LazyMenu
        load={() => menus().then((m) => m.WorkspaceMenu)}
        trigger={{
          variant: 'ghost',
          size: 'sm',
          className: 'gap-1.5 font-medium',
          'aria-label': t('topbar.switchWorkspace'),
        }}
      >
        {workspaceName}
        <ChevronsUpDownIcon aria-hidden className="text-muted-foreground" />
      </LazyMenu>

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
          onPointerEnter={onPalettePrefetch}
          onFocus={onPalettePrefetch}
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
          <LazyMenu
            load={() => menus().then((m) => m.LanguageMenu)}
            trigger={{
              variant: 'ghost',
              size: 'sm',
              className: 'gap-1.5 text-muted-foreground',
              'aria-label': t('language.label'),
            }}
          >
            <LanguagesIcon aria-hidden />
            <span>{locale.toUpperCase()}</span>
          </LazyMenu>
          <LazyMenu
            load={() => menus().then((m) => m.ThemeMenu)}
            trigger={{
              variant: 'ghost',
              size: 'icon',
              className: 'text-muted-foreground',
              'aria-label': t('theme.label'),
            }}
          >
            <SunIcon aria-hidden className="dark:hidden" />
            <MoonIcon aria-hidden className="hidden dark:block" />
          </LazyMenu>
        </div>
        <LazyMenu
          load={() => menus().then((m) => m.NotificationsMenu)}
          trigger={{
            variant: 'ghost',
            size: 'icon',
            className: 'text-muted-foreground',
            'aria-label': t('topbar.notifications'),
          }}
        >
          <BellIcon aria-hidden />
        </LazyMenu>
        <LazyMenu
          load={() => menus().then((m) => m.AccountMenu)}
          trigger={{
            variant: 'ghost',
            size: 'icon',
            className: 'text-muted-foreground',
            'aria-label': t('topbar.account'),
          }}
        >
          <UserIcon aria-hidden />
        </LazyMenu>
      </div>
    </header>
  );
}
