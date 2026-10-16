import type { Asset } from '@bf/site-schema';
import type { SiteAssetCommands } from '../../../sites/index.ts';
import { type SiteImageSource, toWorkspaceAsset } from './workspace-builder.ts';

// A site's image library (BF-035/BF-038) as the workspace's images: processed ones only, the logo first, then the
// widest photos (heroes need ≥ 1200 px), images restricted to previews after the free ones.

export class LibrarySiteImages implements SiteImageSource {
  constructor(private readonly library: Pick<SiteAssetCommands, 'list'>) {}

  async forSite(organizationId: string, siteId: string): Promise<Asset[]> {
    const items = await this.library.list({ organizationId, userId: null }, siteId);
    return items
      .flatMap((item) => toWorkspaceAsset(item as Parameters<typeof toWorkspaceAsset>[0]) ?? [])
      .sort(
        (a, b) =>
          Number(b.kind === 'logo') - Number(a.kind === 'logo') ||
          Number(Boolean(a.restrictions?.length)) - Number(Boolean(b.restrictions?.length)) ||
          b.width - a.width ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 60);
  }
}
