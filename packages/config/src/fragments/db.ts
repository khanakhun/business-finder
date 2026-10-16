import { z } from 'zod';
import { secret } from '../schema.ts';

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/, error: 'Expected a postgres:// URL' });

export const dbEnv = z.object({
  DATABASE_URL: secret(
    postgresUrl.describe(
      'Read-write connection string (owner role; migrations and apps/api). Written by infra:up.',
    ),
  ),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10).describe('Max connections per process.'),
});

export const sitesDbEnv = z.object({
  SITES_DATABASE_URL: secret(
    postgresUrl.describe(
      'Read-only connection string (bf_sites_ro) used by apps/sites. Written by infra:up.',
    ),
  ),
});
