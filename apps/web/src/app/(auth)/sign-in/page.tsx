import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { safeNext } from '@/lib/safe-next.ts';
import { getIdentityConfig, getSession } from '@/lib/server-session.ts';
import { SignInForm } from './sign-in-form.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.signIn'))('title') };
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if (await getSession()) redirect(next);
  const config = await getIdentityConfig();
  return (
    <SignInForm
      next={next}
      googleEnabled={config.googleEnabled}
      signupOpen={config.signupMode !== 'invite_only'}
    />
  );
}
