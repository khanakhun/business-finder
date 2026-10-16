import { afterEach, describe, expect, it } from 'vitest';
import { publicEnv, resetPublicEnv, serverPublicEnv, setPublicEnv } from './public-env.ts';

afterEach(resetPublicEnv);

describe('public env', () => {
  it('reads the server environment at run time, with defaults', () => {
    expect(
      serverPublicEnv({ NEXT_PUBLIC_API_URL: 'https://api.staging.example', NEXT_PUBLIC_APP_URL: '' }),
    ).toEqual({
      apiUrl: 'https://api.staging.example',
      appUrl: 'http://localhost:3000',
      mapStyleUrl: 'https://tiles.openfreemap.org/styles/liberty',
      sitesAssetsUrl: 'https://assets.sites.localhost',
    });
  });

  it('requires the deployment URLs in production', () => {
    expect(() => serverPublicEnv({ NODE_ENV: 'production' })).toThrow(/NEXT_PUBLIC_API_URL is required/);
    expect(
      serverPublicEnv({
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_URL: 'https://api.example',
        NEXT_PUBLIC_APP_URL: 'https://app.example',
      }).mapStyleUrl,
    ).toBe('https://tiles.openfreemap.org/styles/liberty');
  });

  it('refuses malformed URLs', () => {
    expect(() => serverPublicEnv({ NEXT_PUBLIC_API_URL: 'api.example.com' })).toThrow(/NEXT_PUBLIC_API_URL/);
    expect(() => serverPublicEnv({ NEXT_PUBLIC_MAP_STYLE_URL: 'javascript:alert(1)' })).toThrow(
      /NEXT_PUBLIC_MAP_STYLE_URL/,
    );
    expect(() => serverPublicEnv({ NEXT_PUBLIC_SITES_ASSETS_BASE_URL: 'data:x' })).toThrow(
      /NEXT_PUBLIC_SITES_ASSETS_BASE_URL/,
    );
  });

  it('uses the values the server handed over in the browser, defaults before that', () => {
    expect(publicEnv().apiUrl).toBe('http://localhost:4000');
    setPublicEnv({
      apiUrl: 'https://api.example',
      appUrl: 'https://app.example',
      mapStyleUrl: 'https://tiles.example/style.json',
      sitesAssetsUrl: 'https://assets.example',
    });
    expect(publicEnv()).toEqual({
      apiUrl: 'https://api.example',
      appUrl: 'https://app.example',
      mapStyleUrl: 'https://tiles.example/style.json',
      sitesAssetsUrl: 'https://assets.example',
    });
  });
});
