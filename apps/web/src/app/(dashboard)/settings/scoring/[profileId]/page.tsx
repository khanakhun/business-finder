import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ProfileEditor } from '@/features/scoring/editor/profile-editor.tsx';

type Props = { readonly params: Promise<{ profileId: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('scoringEditor'))('title') };
}

export default async function ScoringProfilePage({ params }: Props) {
  const { profileId } = await params;
  if (!UUID.test(profileId)) notFound();
  return <ProfileEditor profileId={profileId} />;
}
