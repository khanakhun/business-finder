import { Button } from '@bf/ui/components/button';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card.tsx';
import { safeNext } from '@/lib/safe-next.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.verify'))('title') };
}

/** Landing page after the email link (Better Auth redirects here, with `?error=` when the link is bad). */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const t = await getTranslations('auth.verify');
  if (params.error) {
    return (
      <AuthCard title={t('failedTitle')}>
        <p>{t('failed')}</p>
        <Button asChild>
          <Link href="/sign-in">{(await getTranslations('auth.signIn'))('submit')}</Link>
        </Button>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t('title')}>
      <p role="status">{t('body')}</p>
      <Button asChild>
        <Link href={safeNext(params.next)}>{t('continue')}</Link>
      </Button>
    </AuthCard>
  );
}
