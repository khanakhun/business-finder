'use client';

import type { ConnectSmtpMailboxRequest } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { toProblemLike } from '@/components/states/problem.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useMailboxActions } from './api.ts';

// Connect an SMTP + IMAP mailbox (BF-050), with presets for common providers. The connection is tested live before
// it is saved; the password goes to the vault and is never shown again.

type Endpoint = { host: string; port: number; security: 'starttls' | 'tls' };
const PRESET_NAMES = [
  'ovh',
  'gandi',
  'infomaniak',
  'zoho',
  'fastmail',
  'icloud',
  'mailpit',
  'custom',
] as const;
type PresetName = (typeof PRESET_NAMES)[number];
const PRESETS: Record<PresetName, { smtp: Endpoint; imap: Endpoint | null }> = {
  ovh: {
    smtp: { host: 'ssl0.ovh.net', port: 465, security: 'tls' },
    imap: { host: 'ssl0.ovh.net', port: 993, security: 'tls' },
  },
  gandi: {
    smtp: { host: 'mail.gandi.net', port: 465, security: 'tls' },
    imap: { host: 'mail.gandi.net', port: 993, security: 'tls' },
  },
  infomaniak: {
    smtp: { host: 'mail.infomaniak.com', port: 465, security: 'tls' },
    imap: { host: 'mail.infomaniak.com', port: 993, security: 'tls' },
  },
  zoho: {
    smtp: { host: 'smtp.zoho.eu', port: 465, security: 'tls' },
    imap: { host: 'imap.zoho.eu', port: 993, security: 'tls' },
  },
  fastmail: {
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
    imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
  },
  icloud: {
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
  },
  mailpit: { smtp: { host: 'localhost', port: 1025, security: 'starttls' }, imap: null },
  custom: {
    smtp: { host: '', port: 587, security: 'starttls' },
    imap: { host: '', port: 993, security: 'tls' },
  },
};

export function ConnectSmtpDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('mailboxes.smtp');
  const canManage = usePermission('settings:manage');
  const { connectSmtp } = useMailboxActions();
  const [preset, setPreset] = React.useState<PresetName>('custom');
  const [email, setEmail] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [smtp, setSmtp] = React.useState<Endpoint>(PRESETS.custom.smtp);
  const [imap, setImap] = React.useState<Endpoint | null>(PRESETS.custom.imap);
  const [appendToSent, setAppendToSent] = React.useState(true);
  const [shared, setShared] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const choose = (name: string) => {
    const chosen = PRESET_NAMES.find((preset) => preset === name);
    if (!chosen) return;
    setPreset(chosen);
    setSmtp(PRESETS[chosen].smtp);
    setImap(PRESETS[chosen].imap);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const body: ConnectSmtpMailboxRequest = {
      email,
      displayName,
      smtp,
      ...(imap ? { imap } : {}),
      username: username || email,
      password,
      appendToSent,
      shared,
    };
    try {
      await connectSmtp.mutateAsync(body);
      (await getToast()).success(t('connected'));
      setPassword('');
      onOpenChange(false);
    } catch (failure) {
      const problem = toProblemLike(failure, t('failed'));
      const field = (failure as { errors?: { message?: string }[] }).errors?.[0]?.message;
      setError(field ? `${problem.title} ${field}` : (problem.detail ?? problem.title));
    }
  };
  const endpoint = (label: string, value: Endpoint, set: (next: Endpoint) => void, id: string) => (
    <fieldset className="grid grid-cols-[1fr_6rem_8rem] gap-2">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      <Input
        aria-label={t('host')}
        placeholder={t('host')}
        value={value.host}
        onChange={(e) => set({ ...value, host: e.target.value })}
        required
        id={`${id}-host`}
      />
      <Input
        aria-label={t('port')}
        type="number"
        min={1}
        max={65535}
        value={value.port}
        onChange={(e) => set({ ...value, port: Number(e.target.value) })}
        required
      />
      <Select
        value={value.security}
        onValueChange={(security) => set({ ...value, security: security as Endpoint['security'] })}
      >
        <SelectTrigger aria-label={t('security')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="tls">{t('tls')}</SelectItem>
          <SelectItem value="starttls">{t('starttls')}</SelectItem>
        </SelectContent>
      </Select>
    </fieldset>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-1">
            <Label htmlFor="smtp-preset">{t('preset')}</Label>
            <Select value={preset} onValueChange={choose}>
              <SelectTrigger id="smtp-preset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESET_NAMES.map((name) => (
                  <SelectItem key={name} value={name}>
                    {t(`presets.${name}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="smtp-email">{t('email')}</Label>
              <Input
                id="smtp-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="smtp-name">{t('displayName')}</Label>
              <Input
                id="smtp-name"
                required
                maxLength={120}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="smtp-user">{t('username')}</Label>
              <Input
                id="smtp-user"
                placeholder={email}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="smtp-password">{t('password')}</Label>
              <Input
                id="smtp-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
          {endpoint(t('smtpServer'), smtp, setSmtp, 'smtp')}
          {imap ? (
            endpoint(t('imapServer'), imap, setImap, 'imap')
          ) : (
            <p className="text-xs text-muted-foreground">{t('noImap')}</p>
          )}
          {imap ? (
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox checked={appendToSent} onCheckedChange={(on) => setAppendToSent(on === true)} />
              {t('appendToSent')}
            </Label>
          ) : null}
          {canManage ? (
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox checked={shared} onCheckedChange={(on) => setShared(on === true)} />
              {t('shared')}
            </Label>
          ) : null}
          <p className="text-xs text-muted-foreground">{t('appPasswordHint')}</p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={connectSmtp.isPending}>
              {connectSmtp.isPending ? t('testing') : t('connect')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
