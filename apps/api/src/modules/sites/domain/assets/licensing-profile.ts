// Licensing profiles (BF-038): what each image source requires, as data. The stock entries follow the providers'
// published API guidelines as read on 2026-10-16 (sources below); re-check them when a provider changes its terms.

export interface LicensingProfile {
  /** `hotlink`: serve the provider's URLs (never a copy); `self`: our storage. */
  readonly hosting: 'self' | 'hotlink';
  /** `{author}` and `{provider}` are replaced; empty when no credit is required. */
  readonly attributionTemplate: string;
  /** A tracking request when a person picks the image (the provider counts "downloads"). */
  readonly downloadTrackingRequired: boolean;
  readonly commercialUseAllowed: boolean;
  /** Requests per hour the provider allows this app (our limiter stays under it). */
  readonly rateLimitPerHour: number | null;
  /** CDN hosts images are hotlinked from (CSP `img-src`, validator `hotlinkHosts`). */
  readonly hotlinkHosts: readonly string[];
  /** Restrictions every image of this source carries. */
  readonly restrictions: readonly 'preview_only'[];
  readonly sources: readonly string[];
}

export const LICENSING_PROFILES = {
  /**
   * Unsplash API guidelines: hotlink `photo.urls` for every use; call `links.download_location` when a person picks
   * an image; credit the photographer and Unsplash with links carrying `utm_source=<app>&utm_medium=referral`; no
   * selling unaltered photos; demo apps get 50 requests an hour (1000 once approved).
   */
  unsplash: {
    hosting: 'hotlink',
    attributionTemplate: 'Photo by {author} on Unsplash',
    downloadTrackingRequired: true,
    commercialUseAllowed: true,
    rateLimitPerHour: 50,
    hotlinkHosts: ['images.unsplash.com'],
    restrictions: [],
    sources: [
      'https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines',
      'https://unsplash.com/documentation#rate-limiting',
    ],
  },
  /**
   * Pexels API documentation: a prominent link to Pexels and photographer credit when possible ("Photo by … on
   * Pexels"); 200 requests an hour, 20,000 a month. Hosting is not restricted: we keep our own copy.
   */
  pexels: {
    hosting: 'self',
    attributionTemplate: 'Photo by {author} on Pexels',
    downloadTrackingRequired: false,
    commercialUseAllowed: true,
    rateLimitPerHour: 200,
    hotlinkHosts: [],
    restrictions: [],
    sources: ['https://www.pexels.com/api/documentation/'],
  },
  /** The business's own website: a private concept preview only, until the business confirms it owns the image. */
  owner_site: {
    hosting: 'self',
    attributionTemplate: '',
    downloadTrackingRequired: false,
    commercialUseAllowed: false,
    rateLimitPerHour: null,
    hotlinkHosts: [],
    restrictions: ['preview_only'],
    sources: ['docs/adr/0013-discovery-providers-and-data-licensing.md'],
  },
  /** AI images: illustrative only, labelled "Illustration" on the site (settings.labelAiImages). */
  ai: {
    hosting: 'self',
    attributionTemplate: '',
    downloadTrackingRequired: false,
    commercialUseAllowed: true,
    rateLimitPerHour: null,
    hotlinkHosts: [],
    restrictions: [],
    sources: ['docs/conventions/ai-engineering.md'],
  },
} as const satisfies Record<string, LicensingProfile>;

export type StockProviderName = 'unsplash' | 'pexels';

/** Every host an image may be hotlinked from (the union of the profiles). */
export const HOTLINK_HOSTS: readonly string[] = Object.values(LICENSING_PROFILES).flatMap(
  (profile) => profile.hotlinkHosts,
);

/** The credit line a profile requires, or undefined. */
export function attributionFor(profile: LicensingProfile, author: string): string | undefined {
  if (!profile.attributionTemplate) return undefined;
  return profile.attributionTemplate.replace('{author}', author.trim().slice(0, 120) || 'unknown');
}
