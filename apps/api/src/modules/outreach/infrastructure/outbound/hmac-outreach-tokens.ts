import { createHmac } from 'node:crypto';
import type { OutreachTokens } from '../../application/outbound/ports.ts';

/**
 * The `?r=` token of a preview link (BF-052): an HMAC of the message id, 16 url-safe characters. Unforgeable
 * without the key, short enough for a link; the message keeps it, so a visit is attributed by lookup.
 */
export class HmacOutreachTokens implements OutreachTokens {
  constructor(private readonly key: string) {}

  sign(messageId: string): string {
    return createHmac('sha256', this.key).update(`outreach:${messageId}`).digest('base64url').slice(0, 16);
  }
}
