/** A link target only for web URLs: provider and crawled data are untrusted (no `javascript:`, `data:`…). */
export function safeWebUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
