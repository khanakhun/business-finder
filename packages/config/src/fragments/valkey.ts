import { z } from 'zod';
import { secret } from '../schema.ts';

export const valkeyEnv = z.object({
  VALKEY_URL: secret(
    z
      .url({ protocol: /^rediss?$/, error: 'Expected a redis:// or rediss:// URL' })
      .describe('Valkey connection (BullMQ, cache, rate limits). May embed a password. Written by infra:up.'),
  ),
});
