import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { safeNext } from '@/lib/safe-next.ts';
import { getIdentityConfig, getSession } from '@/lib/server-session.ts';
import { SignUpForm } from './sign-up-form.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.signUp'))('title') };
}

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if (await getSession()) redirect(next);
  const config = await getIdentityConfig();
  // Invite-only: the form is shown only to people arriving from an invitation (the API still decides).
  const invited = next.startsWith('/invite/');
  return (
    <SignUpForm
      next={next}
      mode={config.signupMode}
      showForm={config.signupMode !== 'invite_only' || invited}
      minPasswordLength={config.minPasswordLength}
    />
  );
}
