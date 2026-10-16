import type { Asset } from '@bf/site-schema';
import type { RenderContext } from '../renderer/types.ts';

// Credits for the images on a page (BF-038): stock photographers as their licences require (Unsplash: the
// photographer and Unsplash, linked with the app's referral parameters; Pexels: the photographer), and a line
// saying AI images are illustrations when the site labels them (settings.labelAiImages, on by default).

/** Asset ids a value names (props ending in AssetId/AssetIds, at any depth). */
function assetIds(value: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) assetIds(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key.endsWith('AssetId') && typeof item === 'string') {
        out.add(item);
      } else if (key.endsWith('AssetIds') && Array.isArray(item)) {
        for (const id of item) if (typeof id === 'string') out.add(id);
      } else {
        assetIds(item, out);
      }
    }
  }
  return out;
}

/** The images shown on the page: its blocks' and the header's logo. */
export function pageAssets(ctx: RenderContext): Asset[] {
  const ids = assetIds(ctx.page.blocks, new Set());
  const logo = ctx.spec.layout.header.logoAssetId;
  if (logo) ids.add(logo);
  return ctx.spec.assets.filter((asset) => ids.has(asset.id));
}

/** The provider's home page with the same referral parameters as the credit's link. */
function providerLink(attributionUrl: string): string | undefined {
  try {
    const url = new URL(attributionUrl);
    const home = new URL(url.origin);
    for (const key of ['utm_source', 'utm_medium']) {
      const value = url.searchParams.get(key);
      if (value) home.searchParams.set(key, value);
    }
    return home.toString();
  } catch {
    return undefined;
  }
}

export function Credits({ ctx }: { ctx: RenderContext }) {
  const assets = pageAssets(ctx);
  const credited = new Map<string, Asset>();
  for (const asset of assets)
    if (asset.license === 'stock' && asset.attribution && !credited.has(asset.attribution))
      credited.set(asset.attribution, asset);
  const illustrations =
    ctx.spec.settings.labelAiImages !== false && assets.some((asset) => asset.license === 'ai_generated');
  if (credited.size === 0 && !illustrations) return null;
  const { Link } = ctx;
  return (
    <p className="bf-muted text-xs" data-bf-credits="">
      {credited.size > 0 ? (
        <>
          {ctx.strings.credits.photos}:{' '}
          {[...credited.values()].map((asset, index) => {
            const text = asset.attribution ?? '';
            const split = text.lastIndexOf(' on ');
            const provider = asset.attributionUrl ? providerLink(asset.attributionUrl) : undefined;
            return (
              <span key={text}>
                {index > 0 ? ', ' : null}
                {asset.attributionUrl && split > 0 ? (
                  <>
                    <Link href={asset.attributionUrl} rel="noopener noreferrer" className="bf-link">
                      {text.slice(0, split)}
                    </Link>
                    {' on '}
                    {provider ? (
                      <Link href={provider} rel="noopener noreferrer" className="bf-link">
                        {text.slice(split + 4)}
                      </Link>
                    ) : (
                      text.slice(split + 4)
                    )}
                  </>
                ) : (
                  text
                )}
              </span>
            );
          })}
          {illustrations ? ' · ' : null}
        </>
      ) : null}
      {illustrations ? ctx.strings.credits.illustrations : null}
    </p>
  );
}
