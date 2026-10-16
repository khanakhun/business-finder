import type { Price, SiteLocale } from '@bf/site-schema';
import { uiStrings } from '../i18n/strings.ts';

/** A price as the locale writes it (`65 €`, `€65`, `à partir de 90 €`, `€450 per night`). */
export function formatPrice(
  price: Pick<Price, 'amount' | 'currency' | 'unit' | 'from'>,
  locale: SiteLocale,
): string {
  const strings = uiStrings(locale);
  const amount = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: price.currency,
    minimumFractionDigits: Number.isInteger(price.amount) ? 0 : 2,
    maximumFractionDigits: Number.isInteger(price.amount) ? 0 : 2,
  }).format(price.amount);
  const text = price.from ? strings.from(amount) : amount;
  return price.unit ? `${text} ${strings.units[price.unit]}` : text;
}
