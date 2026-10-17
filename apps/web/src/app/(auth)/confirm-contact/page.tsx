import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card.tsx';
import { ConfirmContact } from './confirm-contact.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('goLive.confirmContact'))('title') };
}

/** The contact routing email's link (BF-062): no session, the token is the proof. */
export default async function ConfirmContactPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const t = await getTranslations('goLive.confirmContact');
  return (
    <AuthCard title={t('title')}>
      <ConfirmContact token={typeof token === 'string' ? token : ''} />
    </AuthCard>
  );
}
