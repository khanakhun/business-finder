import type { ApiEnv } from '@bf/config';
import { describe, expect, it } from 'vitest';
import { S3PublicFiles, S3UploadSigner } from './site-asset-storage.ts';

const env = {
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
  S3_FORCE_PATH_STYLE: true,
  S3_BUCKET_ASSETS: 'bf-assets',
  S3_BUCKET_SITES: 'bf-sites',
  SITES_ASSETS_BASE_URL: 'https://assets.sites.test/',
} as unknown as ApiEnv;

describe('S3UploadSigner', () => {
  it('signs the content type and length, so the store refuses another type or size', async () => {
    const signer = new S3UploadSigner(env);
    const { url, headers } = await signer.presignPut(
      'orgs/o/sites/s/assets/a/original',
      'image/png',
      1234,
      900,
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/bf-assets/orgs/o/sites/s/assets/a/original');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining(['content-length', 'content-type', 'host']),
    );
    expect(headers).toEqual({ 'Content-Type': 'image/png' });
    signer.onApplicationShutdown();
  });
});

describe('S3PublicFiles', () => {
  it('serves keys under the CDN base URL', () => {
    const files = new S3PublicFiles(env);
    expect(files.url('sites/s/a/480.webp')).toBe('https://assets.sites.test/sites/s/a/480.webp');
    files.onApplicationShutdown();
  });
});
