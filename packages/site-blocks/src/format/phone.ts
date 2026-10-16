import { type CountryCode, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js/min';

/** A country's calling code, or undefined for an unknown country. */
function callingCode(country: string): string | undefined {
  try {
    return getCountryCallingCode(country as CountryCode);
  } catch {
    return undefined;
  }
}

/**
 * A phone number (E.164) as people read it: nationally when it is dialled with the business's country's calling code
 * (`0590 27 00 00`, `0690 00 01 01` on a Saint-Barth site, though +590 numbers parse as Guadeloupe), else
 * internationally (`+590 590 27 00 00`). The link always dials the E.164 value.
 */
export function formatPhone(e164: string, country?: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  return country && callingCode(country) === parsed.countryCallingCode
    ? parsed.formatNational()
    : parsed.formatInternational();
}

/** WhatsApp's click-to-chat link for a number (digits only). */
export const whatsappLink = (e164: string) => `https://wa.me/${e164.replace(/\D/g, '')}`;
