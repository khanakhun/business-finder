import { Button } from '@bf/ui/components/button';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card.tsx';
import { getSession } from '@/lib/server-session.ts';
import { AcceptInvitation } from './accept-invitation.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.invite'))('title') };
}

/** Invitation link from the email. The invitee signs in (or signs up) with the invited address, then accepts. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations('auth.invite');
  if (await getSession()) return <AcceptInvitation invitationId={token} />;
  const next = encodeURIComponent(`/invite/${token}`);
  return (
    <AuthCard title={t('title')}>
      <p>{t('body')}</p>
      <div className="grid gap-2">
        <Button asChild>
          <Link href={`/sign-in?next=${next}`}>{t('signIn')}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/sign-up?next=${next}`}>{t('signUp')}</Link>
        </Button>
      </div>
    </AuthCard>
  );
}
