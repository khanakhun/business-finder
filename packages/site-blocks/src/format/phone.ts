import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

/**
 * A phone number (E.164) as people read it: nationally when the business's country is the number's
 * (`0590 27 00 00`), else internationally (`+590 590 27 00 00`). The link always dials the E.164 value.
 */
export function formatPhone(e164: string, country?: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  return country && parsed.country === country ? parsed.formatNational() : parsed.formatInternational();
}

/** WhatsApp's click-to-chat link for a number (digits only). */
export const whatsappLink = (e164: string) => `https://wa.me/${e164.replace(/\D/g, '')}`;
