import { z } from 'zod';
import { secret } from '../schema.ts';

export const intelEnv = z.object({
  INTEL_URL: z.url().default('http://127.0.0.1:8000').describe('Internal URL of services/intel.'),
  INTEL_SHARED_SECRET: secret(
    z.string().min(32).describe('Shared secret authenticating calls to services/intel, ≥ 32 chars.'),
  ),
});
