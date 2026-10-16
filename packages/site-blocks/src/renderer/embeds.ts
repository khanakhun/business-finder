import { hostAllowed, hostOf, type SiteSpec } from '@bf/site-schema';

/**
 * Booking providers whose pages may be shown in a frame (they allow it and need no third-party script of ours). The
 * frame loads only when the visitor asks for it; sites declare these origins in their CSP `frame-src` (BF-036).
 */
export const BOOKING_EMBED_HOSTS = [
  'calendly.com',
  'acuityscheduling.com',
  'simplybook.me',
  'setmore.com',
  'zenchef.com',
] as const;

export const isEmbeddable = (url: string) => hostAllowed(url, BOOKING_EMBED_HOSTS);

export const hostOfUrl = (url: string) => (hostOf(url) ?? '').replace(/^www\./, '');

/** The origins a site's pages may frame (its booking embed), for the renderer's CSP. */
export function embedOrigins(spec: SiteSpec): string[] {
  const url = spec.contact.bookingUrl?.value;
  const embeds = spec.pages.some((page) =>
    page.blocks.some((block) => block.type === 'booking' && block.variant === 'embed'),
  );
  return url && embeds && isEmbeddable(url) ? [new URL(url).origin] : [];
}
