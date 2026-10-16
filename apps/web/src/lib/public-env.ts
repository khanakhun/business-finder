/**
 * Public URLs of the deployment (API, app, map style), read at **run time**: one web image serves every environment
 * (staging and production run the same images, ADR-0014). The server reads its environment (dynamic access, so the
 * bundler never inlines a build-time value); the root layout hands that value to `<Providers>`, which installs it in
 * the browser before any component renders (`setPublicEnv`).
 */
export interface PublicEnv {
  readonly apiUrl: string;
  readonly appUrl: string;
  readonly mapStyleUrl: string;
  /** Where published sites' images are (the site editor's canvas shows them, BF-037). */
  readonly sitesAssetsUrl: string;
  /** Where the site editor uploads images (presigned PUTs to object storage), when the browser may (BF-037). */
  readonly sitesUploadsUrl: string | null;
}

const DEFAULTS: PublicEnv = {
  apiUrl: 'http://localhost:4000',
  appUrl: 'http://localhost:3000',
  mapStyleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  sitesAssetsUrl: 'https://assets.sites.localhost',
  sitesUploadsUrl: null,
};

const UPLOADS_KEY = 'NEXT_PUBLIC_SITES_UPLOADS_URL';

const KEYS: Record<Exclude<keyof PublicEnv, 'sitesUploadsUrl'>, string> = {
  apiUrl: 'NEXT_PUBLIC_API_URL',
  appUrl: 'NEXT_PUBLIC_APP_URL',
  mapStyleUrl: 'NEXT_PUBLIC_MAP_STYLE_URL',
  sitesAssetsUrl: 'NEXT_PUBLIC_SITES_ASSETS_BASE_URL',
};

/** An optional URL: unset means none; a malformed one fails loudly (it would end up in the CSP). */
function optionalUrl(value: string | undefined): string | null {
  if (!value) return null;
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error(`${UPLOADS_KEY} must be an http(s) URL`);
  }
  return value;
}

/** The server's view (container environment at run time). */
export function serverPublicEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): PublicEnv {
  // A malformed URL fails loudly rather than half-working (the CSP and every API call depend on these).
  const read = (key: keyof typeof KEYS) => {
    const configured = source[KEYS[key]];
    // Local defaults are for development only: a deployed server without its URLs must not point at localhost.
    if (!configured && source.NODE_ENV === 'production' && key !== 'mapStyleUrl') {
      throw new Error(`${KEYS[key]} is required in production`);
    }
    const value = configured || DEFAULTS[key];
    if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
      throw new Error(`${KEYS[key]} must be an http(s) URL`);
    }
    return value;
  };
  return {
    apiUrl: read('apiUrl'),
    appUrl: read('appUrl'),
    mapStyleUrl: read('mapStyleUrl'),
    sitesAssetsUrl: read('sitesAssetsUrl'),
    sitesUploadsUrl: optionalUrl(source[UPLOADS_KEY]),
  };
}

let browserEnv: PublicEnv | undefined;

/** Installs the server's values in the browser (called by `<Providers>` while it renders, before its children). */
export function setPublicEnv(env: PublicEnv): void {
  browserEnv = env;
}

/** Where the API, app, map style and site images live, on the server and in the browser. */
export function publicEnv(): PublicEnv {
  if (typeof window === 'undefined') return serverPublicEnv();
  return browserEnv ?? DEFAULTS;
}

/** Test helper: forget the browser value. */
export function resetPublicEnv(): void {
  browserEnv = undefined;
}
