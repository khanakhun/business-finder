export interface SiteCspOptions {
  readonly dev: boolean;
  /** Served over https (production): ask browsers to upgrade any http subresource. */
  readonly https: boolean;
  /** The API, which receives the view beacon and the lead forms (BF-048). */
  readonly apiOrigin: string;
  /** The CDN of site images (`SITES_ASSETS_BASE_URL`): the only image host besides the page itself. */
  readonly assetsOrigin: string;
  /** Stock CDNs the site's images are hotlinked from (`hotlinkOrigins` of its spec, BF-038); none by default. */
  readonly imageOrigins?: readonly string[];
  /** Booking pages a site may frame (`embedOrigins` of its spec); none by default. */
  readonly frameOrigins: readonly string[];
}

/**
 * The Content-Security-Policy of a rendered site (security.md §8): scripts by nonce only (Next.js applies it to its
 * own scripts), images from the page and our CDN, fonts self-hosted, frames only for the approved booking embed,
 * nothing else from anywhere.
 *
 * DECISION(BF-036): style attributes allow 'unsafe-inline': the theme is applied as CSS variables in a style attribute and
 * images carry their focal point the same way; neither can carry a nonce. Style values come from the validated spec
 * (hex colours, enums), and styles cannot run code.
 */
export function buildSiteCsp(nonce: string, options: SiteCspOptions): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ''}`,
    // Stylesheets and <style> elements by nonce; only style attributes inline (the decision below).
    `style-src 'self' 'nonce-${nonce}'`,
    `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: ${[options.assetsOrigin, ...(options.imageOrigins ?? [])].join(' ')}`,
    "font-src 'self'",
    `connect-src 'self' ${options.apiOrigin}${options.dev ? ' ws:' : ''}`,
    `frame-src ${options.frameOrigins.length > 0 ? options.frameOrigins.join(' ') : "'none'"}`,
    "object-src 'none'",
    "base-uri 'none'",
    // Lead forms of previews post to the API (BF-048), which redirects back here after a plain post.
    `form-action 'self' ${options.apiOrigin}`,
    "frame-ancestors 'none'",
    ...(options.https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
