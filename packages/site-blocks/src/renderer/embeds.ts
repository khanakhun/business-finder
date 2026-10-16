import { HOTLINK_HOSTS, hostOf, type SiteSpec } from '@bf/site-schema';

/**
 * Booking providers whose pages may be shown in a frame (they allow it and need no third-party script of ours). The
 * frame loads only when the visitor asks for it; sites declare these origins in their CSP `frame-src` (BF-036).
 * Exact hosts, except the providers that give each account its own subdomain (`salon.simplybook.me`): one label
 * under them, nothing deeper.
 */
export const BOOKING_EMBED_HOSTS = [
  'calendly.com',
  'app.acuityscheduling.com',
  'simplybook.me',
  'setmore.com',
  'bookings.zenchef.com',
] as const;
const ACCOUNT_SUBDOMAINS: readonly string[] = ['simplybook.me', 'setmore.com'];

export const isEmbeddable = (url: string): boolean => {
  if (!url.startsWith('https://')) return false;
  const host = hostOf(url);
  if (!host) return false;
  return BOOKING_EMBED_HOSTS.some(
    (entry) =>
      host === entry ||
      (ACCOUNT_SUBDOMAINS.includes(entry) &&
        host.endsWith(`.${entry}`) &&
        /^[a-z0-9-]+$/.test(host.slice(0, -entry.length - 1))),
  );
};

export const hostOfUrl = (url: string) => (hostOf(url) ?? '').replace(/^www\./, '');

/** The origins a site's pages may frame (its booking embed), for the renderer's CSP. */
export function embedOrigins(spec: SiteSpec): string[] {
  const url = spec.contact.bookingUrl?.value;
  const embeds = spec.pages.some((page) =>
    page.blocks.some((block) => block.type === 'booking' && block.variant === 'embed'),
  );
  return url && embeds && isEmbeddable(url) ? [new URL(url).origin] : [];
}

/**
 * The image origins a site hotlinks from (BF-038: stock photos whose provider requires it), for the renderer's CSP
 * `img-src`: only the allowed provider CDNs, only when an image of the site uses one.
 */
export function hotlinkOrigins(spec: SiteSpec): string[] {
  const origins = new Set<string>();
  for (const asset of spec.assets) {
    if (asset.hosting !== 'hotlink') continue;
    try {
      const url = new URL(asset.url);
      if (url.protocol === 'https:' && (HOTLINK_HOSTS as readonly string[]).includes(url.hostname))
        origins.add(url.origin);
    } catch {
      // An unparseable URL is refused by the validator; it never widens the policy.
    }
  }
  return [...origins];
}

/** A hotlinked Unsplash image at several widths (its own resizing parameters; the `ixid` stays). */
export function hotlinkSrcSet(url: string): string | undefined {
  try {
    const base = new URL(url);
    if (base.hostname !== 'images.unsplash.com') return undefined;
    return [480, 768, 1200, 1920]
      .map((width) => {
        const sized = new URL(base);
        sized.searchParams.set('w', String(width));
        return `${sized.toString()} ${width}w`;
      })
      .join(', ');
  } catch {
    return undefined;
  }
}
