import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RequestsPage } from '@/features/compliance/admin/requests-page.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('complianceAdmin.nav'))('requests') };
}

export default function Page() {
  return <RequestsPage />;
}
