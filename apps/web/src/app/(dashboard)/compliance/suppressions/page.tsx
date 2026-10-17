import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SuppressionsPage } from '@/features/compliance/admin/suppressions-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('complianceAdmin.nav'))('suppressions') };
}

export default function Page() {
  return <SuppressionsPage />;
}
