'use client';

import { Alert, AlertDescription } from '@bf/ui/components/alert';
import { Button } from '@bf/ui/components/button';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

/** Label + input + optional hint/error, wired with ids and aria attributes. */
export function Field({
  label,
  hint,
  error,
  ...input
}: React.ComponentProps<typeof Input> & {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
}) {
  const id = React.useId();
  const describedBy =
    [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Password field with a show/hide toggle (helps people type long passphrases correctly). */
export function PasswordField(props: React.ComponentProps<typeof Field>) {
  const t = useTranslations('auth');
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="relative">
      <Field {...props} type={visible ? 'text' : 'password'} className="pr-10" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-0.5 top-[1.6rem] size-8 text-muted-foreground"
        onClick={() => setVisible((value) => !value)}
        aria-label={visible ? t('hide') : t('show')}
        aria-pressed={visible}
      >
        {visible ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
      </Button>
    </div>
  );
}

/** A form-level error announced to screen readers. */
export function FormError({ message }: { readonly message: string | null }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

const KNOWN_CODES = [
  'INVALID_EMAIL_OR_PASSWORD',
  'EMAIL_NOT_VERIFIED',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_COMPROMISED',
  'INVALID_CODE',
  'TOO_MANY_REQUESTS',
  'INVALID_TOKEN',
  // API problems: `reason` first (domain rules), then `code`.
  'LAST_OWNER',
  'OWNER_PROTECTED',
  'ROLE_NOT_ASSIGNABLE',
  'NOT_OWNER',
  'SAME_MEMBER',
  'ALREADY_MEMBER',
  'FORBIDDEN',
  'NOT_FOUND',
] as const;
type KnownCode = (typeof KNOWN_CODES)[number];
const isKnown = (code: unknown): code is KnownCode => KNOWN_CODES.includes(code as KnownCode);

/** Maps a Better Auth / API error to a localized sentence (unknown codes get the generic one). */
export function useErrorMessage(): (error: unknown) => string {
  const t = useTranslations('auth.errors');
  return React.useCallback(
    (error: unknown) => {
      const raw = (error as { code?: string; status?: number; problem?: { reason?: string } } | null) ?? {};
      if (raw.status === 429) return t('TOO_MANY_REQUESTS');
      const code = [raw.problem?.reason, raw.code].find(isKnown);
      return code ? t(code) : t('generic');
    },
    [t],
  );
}
