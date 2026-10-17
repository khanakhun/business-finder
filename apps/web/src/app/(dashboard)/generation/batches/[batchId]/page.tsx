import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BatchBoard } from '@/features/generation/board/batch-board.tsx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('generation.board'))('title') };
}

export default async function Page({ params }: { readonly params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  return <BatchBoard batchId={batchId} />;
}
