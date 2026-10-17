import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card.tsx';
import { PortalSignInForm } from '@/features/portal/sign-in-form.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('portal.signIn'))('title') };
}

/** The client portal's sign-in (BF-062): a link by email; `?error=` when a link was used or expired. */
export default async function PortalSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const t = await getTranslations('portal.signIn');
  return (
    <AuthCard title={t('title')}>
      {params.error ? (
        <p role="alert" className="text-sm text-destructive">
          {t('linkFailed')}
        </p>
      ) : null}
      <PortalSignInForm />
    </AuthCard>
  );
}
