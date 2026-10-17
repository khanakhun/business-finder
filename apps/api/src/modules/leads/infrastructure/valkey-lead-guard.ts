import { createHash, randomBytes } from 'node:crypto';
import { type Clock } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { VALKEY } from '../../platform/valkey/valkey.module.ts';
import type { LeadGuard } from '../application/ports.ts';

// Rate limits and replay checks for preview leads (BF-048) in Valkey. A network is kept only as a hash with a salt
// that changes every day and expires after two (the same approach as page views, BF-035): no IP is ever stored.

const PREFIX = 'leads';
const PER_IP_HOUR = 5;
const PER_SITE_DAY = 50;

/** The network an IP belongs to: the address for IPv4, its /64 for IPv6. */
function networkOf(ip: string): string {
  const plain = ip.replace(/^::ffff:/, '');
  if (!plain.includes(':')) return plain;
  return plain.split(':').slice(0, 4).join(':');
}

@Injectable()
export class ValkeyLeadGuard implements LeadGuard {
  constructor(
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private day() {
    return this.clock.now().toISOString().slice(0, 10);
  }

  private async count(key: string, ttlSeconds: number): Promise<number> {
    const value = await this.valkey.incr(key);
    if (value === 1) await this.valkey.expire(key, ttlSeconds);
    return value;
  }

  async networkHash(ip: string | undefined) {
    if (!ip) return null;
    const key = `${PREFIX}:salt:${this.day()}`;
    await this.valkey.set(key, randomBytes(32).toString('hex'), 'EX', 2 * 86_400, 'NX');
    const salt = await this.valkey.get(key);
    if (!salt) return null;
    return createHash('sha256')
      .update(`${salt}|${networkOf(ip)}`)
      .digest('hex')
      .slice(0, 32);
  }

  async overIpLimit(siteId: string, networkHash: string) {
    const hour = this.clock.now().toISOString().slice(0, 13);
    return (await this.count(`${PREFIX}:ip:${siteId}:${networkHash}:${hour}`, 3_600)) > PER_IP_HOUR;
  }

  async overSiteLimit(siteId: string) {
    return (await this.count(`${PREFIX}:site:${siteId}:${this.day()}`, 86_400)) > PER_SITE_DAY;
  }

  async repeated(siteId: string, contentHash: string) {
    const set = await this.valkey.set(`${PREFIX}:content:${siteId}:${contentHash}`, '1', 'EX', 86_400, 'NX');
    return set === null;
  }

  async challengeUsed(signature: string) {
    const key = `${PREFIX}:pow:${createHash('sha256').update(signature).digest('hex').slice(0, 40)}`;
    return (await this.valkey.set(key, '1', 'EX', 2 * 86_400, 'NX')) === null;
  }

  async recentSpam(siteId: string) {
    return Number((await this.valkey.get(`${PREFIX}:spam:${siteId}`)) ?? 0);
  }

  async noteSpam(siteId: string) {
    await this.count(`${PREFIX}:spam:${siteId}`, 3_600);
  }
}
