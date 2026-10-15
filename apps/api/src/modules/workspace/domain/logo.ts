import { LOGO_CONTENT_TYPES, LOGO_MAX_BYTES, ValidationError } from '@bf/contracts';

export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];

/** The image type from its magic bytes; the declared Content-Type is never trusted on its own. */
export function detectImageType(bytes: Buffer): LogoContentType | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

const invalid = (message: string, reason: string) =>
  new ValidationError(message, [{ path: ['body'], message }], { details: { reason } });

/** Accepts PNG, JPEG or WebP up to `LOGO_MAX_BYTES` whose content matches the declared type. */
export function validateLogo(bytes: Buffer, declared: string | undefined): LogoContentType {
  if (bytes.length === 0) throw invalid('The logo is empty.', 'LOGO_EMPTY');
  if (bytes.length > LOGO_MAX_BYTES) throw invalid('The logo is too large.', 'LOGO_TOO_LARGE');
  const detected = detectImageType(bytes);
  const declaredType = declared?.split(';')[0]?.trim().toLowerCase();
  if (!detected || (declaredType !== undefined && declaredType !== detected)) {
    throw invalid('The logo must be a PNG, JPEG or WebP image.', 'LOGO_FORMAT');
  }
  return detected;
}
