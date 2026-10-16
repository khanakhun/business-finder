import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SectionPlaceholder } from '@/components/section-placeholder.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('generation') };
}

export default function Page() {
  return <SectionPlaceholder section="generation" />;
}
