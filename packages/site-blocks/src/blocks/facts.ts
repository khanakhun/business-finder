import type { Price, SiteLocale } from '@bf/site-schema';
import { formatPrice } from '../format/price.ts';
import type { RenderContext } from '../renderer/types.ts';

/** A price as shown: the amount and currency of its fact when the registry is given (the spec is untrusted). */
export function shownPrice(price: Price, ctx: RenderContext): string {
  const fact = ctx.fact(price.factId);
  const value = fact?.kind === 'price' ? { ...price, ...fact.value } : price;
  return formatPrice(value, ctx.locale);
}

/**
 * A quote as shown: the fact's own words in the fact's language; in another language the spec's translation, marked
 * as translated (BF-033: a translation cannot be checked against the fact).
 */
export function shownQuote(
  item: { readonly factId: string; readonly quote: Partial<Record<SiteLocale, string>> },
  ctx: RenderContext,
): { text: string; lang?: SiteLocale | undefined; translated: boolean } {
  const fact = ctx.fact(item.factId);
  if (fact?.kind === 'testimonial' && fact.locale) {
    if (fact.locale === ctx.locale) return { text: fact.value.quote, translated: false };
    const translation = item.quote[ctx.locale];
    return translation
      ? { text: translation, translated: true }
      : { text: fact.value.quote, lang: fact.locale, translated: false };
  }
  return { text: ctx.t(item.quote), translated: false };
}
