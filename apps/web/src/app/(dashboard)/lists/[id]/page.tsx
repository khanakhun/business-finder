import { redirect } from 'next/navigation';

/** A list is a search filtered on it: its businesses get the table, map, facets and bulk actions. */
export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/search?list=${encodeURIComponent(id)}`);
}
