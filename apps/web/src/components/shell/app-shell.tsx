'use client';

import { cn } from '@bf/ui';
import { Sheet, SheetContent, SheetTitle } from '@bf/ui/components/sheet';
import { KeyboardIcon, LanguagesIcon, MonitorIcon, MoonIcon, PanelLeftIcon, SunIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import * as React from 'react';
import { LOCALES } from '@/i18n/locales.ts';
import { type Command, useCommandRegistry, useRegisterCommands } from '@/lib/commands.tsx';
import { isModKey, isTypingTarget } from '@/lib/keyboard.ts';
import { NAV_ITEMS } from '@/lib/navigation.ts';
import { CommandPalette } from './command-palette.tsx';
import { useChangeLocale } from './preferences.tsx';
import { ShortcutsDialog } from './shortcuts-dialog.tsx';
import { Sidebar } from './sidebar.tsx';
import { Topbar } from './topbar.tsx';

const COLLAPSED_KEY = 'bf.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Dashboard frame: sidebar, top bar, command palette and global shortcuts around the page content. */
export function AppShell({ children }: { readonly children: React.ReactNode }) {
  const t = useTranslations();
  const router = useRouter();
  const locale = useLocale();
  const changeLocale = useChangeLocale();
  const { setTheme } = useTheme();
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileNav, setMobileNav] = React.useState(false);
  const [palette, setPalette] = React.useState(false);
  const [shortcuts, setShortcuts] = React.useState(false);

  React.useEffect(() => setCollapsed(readCollapsed()), []);
  const toggleSidebar = React.useCallback(() => {
    setCollapsed((value) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, value ? '0' : '1');
      } catch {
        // Storage can be unavailable (private mode); the toggle still works for this page view.
      }
      return !value;
    });
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isModKey(event) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
      } else if (isModKey(event) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleSidebar();
      } else if (event.key === '?' && !isTypingTarget(event.target)) {
        event.preventDefault();
        setShortcuts(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar]);

  const baseCommands = React.useMemo<Command[]>(() => {
    const navigation = t('commands.groups.navigation');
    const preferences = t('commands.groups.preferences');
    const help = t('commands.groups.help');
    const otherLocale = LOCALES.find((code) => code !== locale) ?? 'en';
    return [
      ...NAV_ITEMS.map((item) => ({
        id: `nav.${item.key}`,
        label: t(`nav.${item.key}`),
        group: navigation,
        icon: <item.icon aria-hidden />,
        run: () => router.push(item.href),
      })),
      {
        id: 'pref.light',
        label: t('commands.useLightTheme'),
        group: preferences,
        icon: <SunIcon aria-hidden />,
        run: () => setTheme('light'),
      },
      {
        id: 'pref.dark',
        label: t('commands.useDarkTheme'),
        group: preferences,
        icon: <MoonIcon aria-hidden />,
        run: () => setTheme('dark'),
      },
      {
        id: 'pref.system',
        label: t('commands.useSystemTheme'),
        group: preferences,
        icon: <MonitorIcon aria-hidden />,
        run: () => setTheme('system'),
      },
      {
        id: 'pref.locale',
        label: t('commands.switchLanguage', { language: t(`language.${otherLocale}`) }),
        group: preferences,
        icon: <LanguagesIcon aria-hidden />,
        run: () => changeLocale(otherLocale),
      },
      {
        id: 'pref.sidebar',
        label: t('commands.toggleSidebar'),
        group: preferences,
        icon: <PanelLeftIcon aria-hidden />,
        shortcut: ['mod', 'b'],
        run: toggleSidebar,
      },
      {
        id: 'help.shortcuts',
        label: t('commands.showShortcuts'),
        group: help,
        icon: <KeyboardIcon aria-hidden />,
        shortcut: ['?'],
        run: () => setShortcuts(true),
      },
    ];
  }, [t, locale, router, setTheme, changeLocale, toggleSidebar]);
  useRegisterCommands(baseCommands);
  const { commands } = useCommandRegistry();

  return (
    <div className="flex min-h-dvh">
      <a
        href="#content"
        className="sr-only z-50 rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        {t('app.skipToContent')}
      </a>
      <aside
        className={cn(
          'sticky top-0 hidden h-dvh shrink-0 border-r transition-[width] duration-150 md:block',
          collapsed ? 'w-14' : 'w-58',
        )}
      >
        <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
      </aside>
      <Sheet open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetTitle className="sr-only">{t('nav.label')}</SheetTitle>
          <Sidebar collapsed={false} onNavigate={() => setMobileNav(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenPalette={() => setPalette(true)} onOpenMobileNav={() => setMobileNav(true)} />
        <main id="content" tabIndex={-1} className="w-full max-w-6xl flex-1 px-4 py-8 outline-none sm:px-8">
          {children}
        </main>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} commands={commands} />
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
    </div>
  );
}
