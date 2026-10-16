import type { Price, SiteLocale } from '@bf/site-schema';
import { formatPrice } from '../format/price.ts';
import type { RenderContext } from '../renderer/types.ts';

/** A price as shown: the amount and currency of its fact when the registry is given (the spec is untrusted). */
export function shownPrice(price: Price, ctx: RenderContext): string {
  const fact = ctx.fact(price.factId);
  // With a registry, a price without its fact is not shown (an invented amount).
  if (ctx.options.facts && fact?.kind !== 'price') return '';
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
  if (fact?.kind === 'testimonial') {
    // A fact without a language: the spec's words are shown as the reviewer's only when they are the fact's;
    // anything else is a translation, and says so.
    const own = item.quote[ctx.locale];
    if (!own || sameWords(own, fact.value.quote)) return { text: fact.value.quote, translated: false };
    return { text: own, translated: true };
  }
  return { text: ctx.t(item.quote), translated: false };
}

const words = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const sameWords = (a: string, b: string) => words(a) === words(b);

/**
 * A review's author and rating as shown: from its fact when the registry is given (the spec may leave either out,
 * never change it); the spec's own only without a registry (the editor's previews before facts load).
 */
export function shownReviewer(
  item: {
    readonly factId: string;
    readonly author?: string | undefined;
    readonly rating?: number | undefined;
  },
  ctx: RenderContext,
): { author: string | undefined; rating: number | undefined } {
  const fact = ctx.fact(item.factId);
  if (fact?.kind !== 'testimonial')
    // With a registry, a review without its fact shows no author or rating of its own (the spec is untrusted).
    return ctx.options.facts
      ? { author: undefined, rating: undefined }
      : { author: item.author, rating: item.rating };
  return {
    author: item.author ? fact.value.author : undefined,
    rating: item.rating ? fact.value.rating : undefined,
  };
}

/** A review shown on the page: with a registry, only one backed by a testimonial fact (a quote nobody wrote is not). */
export const reviewShown = (item: { readonly factId: string }, ctx: RenderContext): boolean =>
  !ctx.options.facts || ctx.fact(item.factId)?.kind === 'testimonial';
