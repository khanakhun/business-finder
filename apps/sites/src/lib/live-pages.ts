import 'server-only';
import { rendererSiteLegal } from '@bf/db/read-models';
import { eq } from 'drizzle-orm';
import { rendererDb } from './tenant.ts';

// A live site's own pages (BF-062): the legal notice (/legal) and the privacy notice (/privacy), generated from the
// business's legal profile, in each of the site's languages (`/legal`, `/en/legal`…), like the preview's lead pages.

export { LIVE_PAGES, type LivePage, livePageOf } from './live-paths.ts';

export type SiteLegal = typeof rendererSiteLegal.$inferSelect;

/** The legal profile of a live site (null while it has none: the pages say so). */
export async function siteLegal(siteId: string): Promise<SiteLegal | null> {
  const [row] = await rendererDb()
    .select()
    .from(rendererSiteLegal)
    .where(eq(rendererSiteLegal.siteId, siteId))
    .limit(1);
  return row ?? null;
}
