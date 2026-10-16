// Website URLs that leave us (BF-030): to PageSpeed (Google fetches them) and to the vision model (context only).
// Credentials, query and fragment are stripped: session or tracking tokens a crawl picked up never leave us.

/** The page's address without credentials, query or fragment; http(s) only. Null when it is not a web URL. */
export function contextUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** The URL handed to PageSpeed: `contextUrl`, and no IP-literal hosts (quota spent on nothing). */
export function analysableUrl(raw: string): string | null {
  const url = contextUrl(raw);
  if (!url) return null;
  const host = new URL(url).hostname;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') ? null : url;
}
