import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { safeNext } from '@/lib/safe-next.ts';
import { TwoFactorForm } from './two-factor-form.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.twoFactor'))('title') };
}

export default async function TwoFactorPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  return <TwoFactorForm next={safeNext((await searchParams).next)} />;
}
