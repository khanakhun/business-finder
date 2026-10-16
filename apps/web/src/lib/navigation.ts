import {
  BarChart3Icon,
  GlobeIcon,
  InboxIcon,
  KanbanSquareIcon,
  LayoutDashboardIcon,
  ListOrderedIcon,
  type LucideIcon,
  MailIcon,
  MailsIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
} from 'lucide-react';

/** Message key under `nav.*`. */
export type NavKey =
  | 'home'
  | 'search'
  | 'pipeline'
  | 'sites'
  | 'generation'
  | 'inbox'
  | 'sequences'
  | 'templates'
  | 'mailboxes'
  | 'analytics'
  | 'settings';

export interface NavItem {
  readonly key: NavKey;
  readonly href: string;
  readonly icon: LucideIcon;
}

export interface NavGroup {
  /** Message key under `nav.groups.*`; `null` for the ungrouped top entry. */
  readonly key: 'prospects' | 'websites' | 'outreach' | 'workspace' | null;
  readonly items: readonly NavItem[];
}

/** The dashboard's information architecture. Feature tickets replace placeholders, not this list. */
export const NAVIGATION: readonly NavGroup[] = [
  { key: null, items: [{ key: 'home', href: '/', icon: LayoutDashboardIcon }] },
  {
    key: 'prospects',
    items: [
      { key: 'search', href: '/search', icon: SearchIcon },
      { key: 'pipeline', href: '/pipeline', icon: KanbanSquareIcon },
    ],
  },
  {
    key: 'websites',
    items: [
      { key: 'sites', href: '/sites', icon: GlobeIcon },
      { key: 'generation', href: '/generation', icon: SparklesIcon },
    ],
  },
  {
    key: 'outreach',
    items: [
      { key: 'inbox', href: '/outreach/inbox', icon: InboxIcon },
      { key: 'sequences', href: '/outreach/sequences', icon: ListOrderedIcon },
      { key: 'templates', href: '/outreach/templates', icon: MailIcon },
      { key: 'mailboxes', href: '/outreach/mailboxes', icon: MailsIcon },
    ],
  },
  {
    key: 'workspace',
    items: [
      { key: 'analytics', href: '/analytics', icon: BarChart3Icon },
      { key: 'settings', href: '/settings', icon: SettingsIcon },
    ],
  },
];

export const NAV_ITEMS: readonly NavItem[] = NAVIGATION.flatMap((group) => group.items);

/** The nav item a pathname belongs to (longest matching prefix; `/` only matches exactly). */
export function activeNavItem(pathname: string): NavItem | undefined {
  return [...NAV_ITEMS]
    .filter((item) =>
      item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`),
    )
    .sort((a, b) => b.href.length - a.href.length)[0];
}
