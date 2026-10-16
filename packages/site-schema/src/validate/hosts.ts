// Hosts a site may link to (BF-033): its own assets on our storage, the business's own domain, known booking
// providers and the social networks' own hosts. Everything else is an external URL and refused.

/** Online booking providers a business may already use (its booking page may be linked). */
export const KNOWN_BOOKING_HOSTS = [
  'acuityscheduling.com',
  'airbnb.com',
  'booking.com',
  'booksy.com',
  'calendly.com',
  'doctolib.fr',
  'fresha.com',
  'lafourchette.com',
  'opentable.com',
  'opentable.fr',
  'planity.com',
  'resy.com',
  'setmore.com',
  'sevenrooms.com',
  'simplybook.me',
  'thefork.com',
  'thefork.fr',
  'treatwell.co.uk',
  'treatwell.fr',
  'zenchef.com',
] as const;

/** Each network's own hosts (a profile URL must be on one of them). */
export const SOCIAL_HOSTS: Readonly<Record<string, readonly string[]>> = {
  instagram: ['instagram.com'],
  facebook: ['facebook.com', 'fb.com'],
  tiktok: ['tiktok.com'],
  linkedin: ['linkedin.com'],
  youtube: ['youtube.com', 'youtu.be'],
  x: ['x.com', 'twitter.com'],
  tripadvisor: [
    'tripadvisor.com',
    'tripadvisor.fr',
    'tripadvisor.co.uk',
    'tripadvisor.de',
    'tripadvisor.es',
    'tripadvisor.nl',
  ],
  google: ['google.com', 'g.page', 'maps.app.goo.gl'],
};

export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The host is one of `allowed` or a subdomain of one. */
export function hostAllowed(url: string, allowed: readonly string[]): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return allowed.some((entry) => {
    const domain = entry.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  });
}
