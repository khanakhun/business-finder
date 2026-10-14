import { z } from 'zod';
import { secret } from '../schema.ts';

export const authEnv = z.object({
  BETTER_AUTH_SECRET: secret(
    z.string().min(32).describe('Better Auth signing secret, ≥ 32 chars. Generate: openssl rand -base64 32'),
  ),
  SECRETS_MASTER_KEY: secret(
    z
      .base64()
      .refine((value) => Buffer.from(value, 'base64').length === 32, 'Expected 32 bytes, base64-encoded')
      .describe(
        'Master key wrapping workspace secret data keys (AES-256-GCM). Generate: openssl rand -base64 32',
      ),
  ),
});
