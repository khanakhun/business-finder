import { type CountryCode, parsePhoneNumberWithError } from 'libphonenumber-js/max';
import { InvalidValueError } from '../errors.ts';

export type PhoneType = 'mobile' | 'landline' | 'unknown';

/** A phone number in E.164 with its country and line type (libphonenumber metadata, BL/MF/GP aware). */
export class PhoneNumber {
  private constructor(
    readonly e164: string,
    readonly country: string | null,
    readonly type: PhoneType,
    readonly international: string,
  ) {}

  /** `regionHint` (ISO 3166-1) reads national formats like `0690 12 34 56` in Saint-Barthélemy. */
  static parse(raw: string, regionHint?: string): PhoneNumber {
    const text = raw.trim();
    if (!/\d/.test(text) || text.length > 40) throw new InvalidValueError('phone', 'Not a phone number.');
    let parsed: ReturnType<typeof parsePhoneNumberWithError>;
    try {
      parsed = parsePhoneNumberWithError(
        text,
        (regionHint?.toUpperCase() as CountryCode | undefined) ?? undefined,
      );
    } catch {
      throw new InvalidValueError('phone', 'Not a phone number.');
    }
    if (!parsed.isValid()) throw new InvalidValueError('phone', 'Not a valid phone number for its country.');
    const kind = parsed.getType();
    const type: PhoneType =
      kind === 'MOBILE'
        ? 'mobile'
        : kind === 'FIXED_LINE'
          ? 'landline'
          : kind === 'FIXED_LINE_OR_MOBILE'
            ? 'unknown'
            : 'unknown';
    return new PhoneNumber(parsed.number, parsed.country ?? null, type, parsed.formatInternational());
  }

  equals(other: PhoneNumber): boolean {
    return this.e164 === other.e164;
  }

  toString(): string {
    return this.e164;
  }
}
