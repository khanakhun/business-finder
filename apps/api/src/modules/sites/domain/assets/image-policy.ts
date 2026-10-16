// What may become a site image (BF-038, ADR-0013): provider photos never; owner-site images only when they are real
// photos (not icons, sprites, tracking pixels or blurry thumbnails). Pure: the infrastructure measures, this decides.

/**
 * Hosts of map, review and booking providers' photos (Google, Foursquare, TripAdvisor, Yelp, Meta, Booking.com,
 * Airbnb): their terms forbid reusing them in generated sites. Matched as the host or a parent domain.
 */
export const PROVIDER_PHOTO_HOSTS = [
  'googleusercontent.com',
  'ggpht.com',
  'gstatic.com',
  'maps.googleapis.com',
  '4sqi.net',
  'foursquare.com',
  'tripadvisor.com',
  'tacdn.com',
  'yelpcdn.com',
  'yelp.com',
  'fbcdn.net',
  'facebook.com',
  'cdninstagram.com',
  'instagram.com',
  'bstatic.com',
  'booking.com',
  'muscache.com',
  'airbnb.com',
] as const;

/** Whether the URL is a provider's photo (never usable on a site). Unparseable URLs count as one. */
export function isProviderPhoto(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return true;
  }
  return PROVIDER_PHOTO_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** The shortest side a photo needs to be worth showing (a 600 px thumbnail is the floor for a gallery). */
export const MIN_PHOTO_SHORT_SIDE = 600;
/** A logo is small by nature, but not an icon. */
export const MIN_LOGO_SHORT_SIDE = 48;
/** Variance of the Laplacian (512 px grey copy) under which an image is blurry. */
export const BLUR_THRESHOLD = 60;

export interface MeasuredImage {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  /** null when it could not be measured (vector logos). */
  readonly sharpness: number | null;
}

export type ImageVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'provider_photo' | 'tracking_pixel' | 'sprite' | 'icon' | 'too_small' | 'blurry';
    };

const SPRITE_OR_ICON =
  /(?:^|[/_.-])(sprite|sprites|icon|icons|favicon|emoji|spacer|pixel|blank)(?:[/_.-]|$)/i;

/** Whether an image found on the business's own website may join its library, as a photo or as a logo. */
export function judgeOwnerImage(image: MeasuredImage, kind: 'photo' | 'logo'): ImageVerdict {
  if (isProviderPhoto(image.url)) return { ok: false, reason: 'provider_photo' };
  const short = Math.min(image.width, image.height);
  const long = Math.max(image.width, image.height);
  if (short <= 4) return { ok: false, reason: 'tracking_pixel' };
  if (long / short > 5) return { ok: false, reason: 'sprite' };
  let path = '';
  try {
    path = new URL(image.url).pathname;
  } catch {
    // isProviderPhoto already refused unparseable URLs.
  }
  if (kind === 'photo') {
    if (SPRITE_OR_ICON.test(path)) return { ok: false, reason: 'icon' };
    if (short < MIN_PHOTO_SHORT_SIDE) return { ok: false, reason: 'too_small' };
    if (image.sharpness !== null && image.sharpness < BLUR_THRESHOLD) return { ok: false, reason: 'blurry' };
    return { ok: true };
  }
  if (short < MIN_LOGO_SHORT_SIDE) return { ok: false, reason: 'too_small' };
  return { ok: true };
}
