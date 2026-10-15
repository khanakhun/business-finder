import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getIdentityConfig } from '@/lib/server-session.ts';
import { ResetPasswordForm } from './reset-password-form.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.reset'))('title') };
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const config = await getIdentityConfig();
  return <ResetPasswordForm token={token ?? null} minPasswordLength={config.minPasswordLength} />;
}
