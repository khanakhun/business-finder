'use client';

import { Button } from '@bf/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@bf/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@bf/ui/components/popover';
import {
  BellIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
  PlusIcon,
  SettingsIcon,
  UserIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { Field, FormError, useErrorMessage } from '@/components/auth/fields.tsx';
import { authClient, unwrap } from '@/lib/auth-client.ts';
import { useSession } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { LanguageMenu as LanguageMenuBase, ThemeMenu as ThemeMenuBase } from './preferences.tsx';

// The real top-bar menus, loaded by LazyMenu on first intent. Triggers match the placeholders exactly.

export function WorkspaceMenu({ defaultOpen }: { readonly defaultOpen: boolean }) {
  const t = useTranslations();
  const me = useSession();
  const [creating, setCreating] = React.useState(false);
  const active = me.activeOrganization;

  const errorMessage = useErrorMessage();
  const switchTo = async (organizationId: string) => {
    try {
      await unwrap(authClient().organization.setActive({ organizationId }));
      // Server components (layout, pages) read the new workspace on the next request.
      window.location.assign('/');
    } catch (error) {
      (await getToast()).error(errorMessage(error));
    }
  };

  return (
    <>
      <DropdownMenu defaultOpen={defaultOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 font-medium"
            aria-label={t('topbar.switchWorkspace')}
          >
            {active?.name ?? t('workspace.none')}
            <ChevronsUpDownIcon aria-hidden className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuLabel>{t('workspace.switch')}</DropdownMenuLabel>
          {me.organizations.map((org) => (
            <DropdownMenuItem
              key={org.id}
              onSelect={() => void switchTo(org.id)}
              disabled={org.id === active?.id}
            >
              <span className="flex-1 truncate">{org.name}</span>
              <span className="text-xs text-muted-foreground">{t(`roles.${org.role}`)}</span>
              {org.id === active?.id ? <CheckIcon aria-label={t('workspace.current')} /> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <PlusIcon aria-hidden />
            {t('workspace.create')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {creating ? <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} /> : null}
    </>
  );
}

function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name')).trim();
    const slug = `${
      name
        .toLowerCase()
        .normalize('NFKD')
        .replaceAll(/[^a-z0-9]+/g, '-')
        .replaceAll(/^-|-$/g, '') || 'workspace'
    }-${crypto.randomUUID().slice(0, 6)}`;
    setError(null);
    setPending(true);
    try {
      const org = await unwrap(authClient().organization.create({ name, slug }));
      await unwrap(authClient().organization.setActive({ organizationId: org.id }));
      window.location.assign('/');
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workspace.createTitle')}</DialogTitle>
          <DialogDescription>{t('workspace.createDescription')}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <FormError message={error} />
          <Field label={t('workspace.nameLabel')} name="name" required maxLength={80} autoFocus />
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {t('workspace.createSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  const t = useTranslations();
  const { user } = useSession();
  const errorMessage = useErrorMessage();
  const signOut = async () => {
    try {
      await unwrap(authClient().signOut());
      window.location.assign('/sign-in');
    } catch (error) {
      (await getToast()).error(errorMessage(error));
    }
  };
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
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
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="grid">
          <span className="truncate">{user.name}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {t('topbar.signedInAs', { email: user.email })}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/account">
            <SettingsIcon aria-hidden />
            {t('topbar.accountSettings')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOutIcon aria-hidden />
          {t('auth.signOut')}
        </DropdownMenuItem>
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
