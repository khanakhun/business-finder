// E-mail addresses in text (BF-033), shared by the facts validator (an address must be a fact) and the web-address
// scan (an address is not a web address unless dressed as one), so both read the same addresses.

/**
 * The `@` of an address, also spelled out against scrapers: `@`, ` @ ` (spaces on both sides, so a handle after a
 * word — `Suivez-nous @salon.lumiere` — is not an address), `(at)` and `[at]` in any case.
 */
export const EMAIL_AT = String.raw`(?:@|\s{1,2}@\s{1,2}|\s?[([]at[)\]]\s?)`;

/** Replaces a spelled-out `@` with `@` (`name (at) domain.fr` → `name@domain.fr`). */
export const unspell = (address: string) => address.replace(new RegExp(EMAIL_AT, 'i'), '@');
