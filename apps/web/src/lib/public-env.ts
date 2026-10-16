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
}

const DEFAULTS: PublicEnv = {
  apiUrl: 'http://localhost:4000',
  appUrl: 'http://localhost:3000',
  mapStyleUrl: 'https://tiles.openfreemap.org/styles/liberty',
};

const KEYS: Record<keyof PublicEnv, string> = {
  apiUrl: 'NEXT_PUBLIC_API_URL',
  appUrl: 'NEXT_PUBLIC_APP_URL',
  mapStyleUrl: 'NEXT_PUBLIC_MAP_STYLE_URL',
};

/** The server's view (container environment at run time). */
export function serverPublicEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): PublicEnv {
  // A malformed URL fails loudly rather than half-working (the CSP and every API call depend on these).
  const read = (key: keyof PublicEnv) => {
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
  return { apiUrl: read('apiUrl'), appUrl: read('appUrl'), mapStyleUrl: read('mapStyleUrl') };
}

let browserEnv: PublicEnv | undefined;

/** Installs the server's values in the browser (called by `<Providers>` while it renders, before its children). */
export function setPublicEnv(env: PublicEnv): void {
  browserEnv = env;
}

/** Where the API, app and map style live, on the server and in the browser. */
export function publicEnv(): PublicEnv {
  if (typeof window === 'undefined') return serverPublicEnv();
  return browserEnv ?? DEFAULTS;
}

/** Test helper: forget the browser value. */
export function resetPublicEnv(): void {
  browserEnv = undefined;
}
