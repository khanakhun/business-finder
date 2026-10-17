import type { SiteSpec } from '@bf/site-schema';

// LocalBusiness structured data for a live site (BF-062), built from the spec's contact block only — every value
// there comes from a confirmed fact (the schema requires a fact id) — never from free text.

const DAYS: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export function localBusinessJsonLd(spec: SiteSpec, origin: string): Record<string, unknown> {
  const contact = spec.contact as SiteSpec['contact'] & {
    phone?: { value: string };
    email?: { value: string };
    address?: { street?: string; postalCode?: string; locality: string; region?: string; country: string };
    geo?: { lat: number; lng: number };
    hours?: { weekly: Record<string, { open: string; close: string }[]> };
    socials?: { url: string }[];
  };
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: spec.brand.name,
    url: origin,
  };
  if (contact.phone) data.telephone = contact.phone.value;
  if (contact.email) data.email = contact.email.value;
  if (contact.address)
    data.address = {
      '@type': 'PostalAddress',
      ...(contact.address.street ? { streetAddress: contact.address.street } : {}),
      ...(contact.address.postalCode ? { postalCode: contact.address.postalCode } : {}),
      addressLocality: contact.address.locality,
      ...(contact.address.region ? { addressRegion: contact.address.region } : {}),
      addressCountry: contact.address.country,
    };
  if (contact.geo)
    data.geo = { '@type': 'GeoCoordinates', latitude: contact.geo.lat, longitude: contact.geo.lng };
  if (contact.hours)
    data.openingHoursSpecification = Object.entries(contact.hours.weekly).flatMap(([day, spans]) =>
      spans.map((span) => ({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: DAYS[day],
        opens: span.open,
        closes: span.close,
      })),
    );
  const sameAs = (contact.socials ?? []).map((social) => social.url);
  if (sameAs.length) data.sameAs = sameAs;
  return data;
}

/** Safe inside a <script>: no `</script>` or HTML comment can close it early. */
export const jsonLdText = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');
