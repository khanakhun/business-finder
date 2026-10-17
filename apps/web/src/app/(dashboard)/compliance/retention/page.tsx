import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RetentionPage } from '@/features/compliance/admin/retention-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('complianceAdmin.nav'))('retention') };
}

export default function Page() {
  return <RetentionPage />;
}
