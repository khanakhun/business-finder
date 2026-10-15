const BASE = 'http://same-origin.invalid';

/** Same-origin path from `?next=`, so sign-in can never redirect to another site (open-redirect guard). */
export function safeNext(value: string | null | undefined, fallback = '/'): string {
  // Control characters and backslashes are rejected outright: URL parsers drop or reinterpret them ("/\t/x" → "//x").
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  if (!value?.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  try {
    const url = new URL(value, BASE);
    return url.origin === BASE ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
}
