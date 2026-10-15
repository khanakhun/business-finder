import type { PostalAddress as PostalAddressShape } from '@bf/contracts';
import { InvalidValueError } from '../errors.ts';

/** A street address in components; `formatted` is a single display line. */
export class PostalAddress {
  private constructor(
    readonly components: Readonly<Partial<PostalAddressShape>>,
    private readonly displayLine: string | undefined,
  ) {}

  /** `formatted`: the address as the source wrote it (kept verbatim); otherwise built from the components. */
  static of(components: Partial<PostalAddressShape>, formatted?: string): PostalAddress {
    const clean = Object.fromEntries(
      Object.entries(components)
        .map(([key, value]) => [key, typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value])
        .filter(([, value]) => value !== undefined && value !== ''),
    ) as Partial<PostalAddressShape>;
    if (clean.countryCode !== undefined) {
      clean.countryCode = clean.countryCode.toUpperCase();
      if (!/^[A-Z]{2}$/.test(clean.countryCode))
        throw new InvalidValueError('address', 'Unknown country code.');
    }
    if (Object.keys(clean).length === 0) throw new InvalidValueError('address', 'The address is empty.');
    const line = formatted?.replace(/\s+/g, ' ').trim();
    return new PostalAddress(clean, line || undefined);
  }

  get formatted(): string {
    if (this.displayLine) return this.displayLine;
    const { line1, line2, postalCode, city, region, countryCode } = this.components;
    return [line1, line2, [postalCode, city].filter(Boolean).join(' '), region, countryCode]
      .filter(Boolean)
      .join(', ');
  }
}
