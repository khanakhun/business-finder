import { z } from 'zod';
import { secret } from '../schema.ts';

export const mailEnv = z.object({
  SMTP_URL: secret(
    z
      .url({ protocol: /^smtps?$/, error: 'Expected an smtp:// or smtps:// URL' })
      .describe('System mail transport (verification, invites). Mailpit locally. May embed credentials.'),
  ),
  MAIL_FROM: z
    .string()
    .min(3)
    .default('Business Finder <no-reply@localhost>')
    .describe('From header for system emails. Never used for prospect outreach.'),
});
