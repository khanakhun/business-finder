import { z } from 'zod';
import { booleanFlag, secret } from '../schema.ts';

export const s3Env = z.object({
  S3_ENDPOINT: z.url().describe('S3-compatible endpoint (RustFS locally). Written by infra:up.'),
  S3_REGION: z.string().min(1).default('us-east-1').describe('Bucket region.'),
  S3_ACCESS_KEY_ID: secret(z.string().min(1).describe('S3 access key id.')),
  S3_SECRET_ACCESS_KEY: secret(z.string().min(1).describe('S3 secret access key.')),
  S3_FORCE_PATH_STYLE: booleanFlag(true).describe(
    'Path-style URLs (required by RustFS/MinIO; false for AWS).',
  ),
  S3_BUCKET_ASSETS: z.string().min(3).default('bf-assets').describe('Site assets (versioned).'),
  S3_BUCKET_ARTIFACTS: z
    .string()
    .min(3)
    .default('bf-artifacts')
    .describe('Crawl artifacts, screenshots, models.'),
  S3_BUCKET_SITES: z.string().min(3).default('bf-sites').describe('Published static site exports.'),
});
