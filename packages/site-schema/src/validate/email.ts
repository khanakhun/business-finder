// E-mail addresses in text (BF-033): one pattern for the facts validator (an address must be a fact) and the
// web-address scan (an address is left to the facts validator unless it is dressed as a web address), so both read
// exactly the same addresses — the same characters, the same ends.

/**
 * The `@` of an address, also spelled out against scrapers: `@`, ` @ ` (spaces on both sides, so a handle after a
 * word — `Suivez-nous @salon.lumiere` — is not an address), `(at)` and `[at]` in any case.
 */
export const EMAIL_AT = String.raw`(?:@|\s{1,2}@\s{1,2}|\s?[([]at[)\]]\s?)`;

const LOCAL = String.raw`[\p{L}\p{N}_.%+-]{1,64}`;
const DOMAIN = String.raw`[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,10}`;

/**
 * An e-mail address in text, plain or spelled out; its local part is group 1. Anchored on both sides (no address
 * starts inside a word or stops inside one: `bonjour@salon.example_evil.com` is none) and bounded, so linear.
 */
export const emailPattern = () =>
  new RegExp(
    String.raw`(?<![\p{L}\p{N}_.%+-])(${LOCAL})${EMAIL_AT}${DOMAIN}(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])`,
    'giu',
  );

/** Replaces a spelled-out `@` with `@` (`name (at) domain.fr` → `name@domain.fr`). */
export const unspell = (address: string) => address.replace(new RegExp(EMAIL_AT, 'i'), '@');
