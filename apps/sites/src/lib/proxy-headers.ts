/** Headers only the proxy may set: a visitor's own values are always dropped. */
const PROXY_HEADERS = ['x-nonce', 'content-security-policy'];

/** The request's headers without any the proxy owns (`x-nonce`, the CSP, every `x-bf-*`). */
export function cleanHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of PROXY_HEADERS) headers.delete(name);
  for (const name of [...headers.keys()]) if (name.startsWith('x-bf-')) headers.delete(name);
  return headers;
}
