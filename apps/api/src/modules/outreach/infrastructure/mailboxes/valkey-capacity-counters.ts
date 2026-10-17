import { randomUUID } from 'node:crypto';
import type { Clock } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { VALKEY } from '../../../platform/valkey/valkey.module.ts';
import type {
  CapacityCounters,
  ReserveInput,
  ReserveRefusal,
  RunLock,
} from '../../application/mailbox/ports.ts';

// Atomic capacity accounting (BF-050, Reservation pattern) in Valkey Lua scripts: a send is reserved against the
// mailbox's daily cap, the workspace's daily cap and the recipient domain's hourly limit at once; reservations are
// members of sorted sets scored by expiry (an abandoned one frees itself); commit counts it as sent exactly once.

const PREFIX = 'outreach:mbx';
const DAY_TTL = 3 * 86_400;

const sentKey = (mailboxId: string, day: string) => `${PREFIX}:sent:${mailboxId}:${day}`;
const heldKey = (mailboxId: string, day: string) => `${PREFIX}:held:${mailboxId}:${day}`;
const orgSentKey = (orgId: string, day: string) => `${PREFIX}:org-sent:${orgId}:${day}`;
const orgHeldKey = (orgId: string, day: string) => `${PREFIX}:org-held:${orgId}:${day}`;
const domainKey = (orgId: string, domain: string, hour: string) =>
  `${PREFIX}:domain:${orgId}:${domain}:${hour}`;
const tokenKey = (token: string) => `${PREFIX}:token:${token}`;
const lastSentKey = (mailboxId: string) => `${PREFIX}:last:${mailboxId}`;

// KEYS: sent, held, orgSent, orgHeld, domain, token. ARGV: now, expiresAt, token, cap, orgCap, domainLimit,
// dayTtl, tokenTtl, tokenValue.
const RESERVE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'UNSEEDED' end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', ARGV[1])
local used = tonumber(redis.call('GET', KEYS[1])) + redis.call('ZCARD', KEYS[2])
if used >= tonumber(ARGV[4]) then return 'MAILBOX_CAP' end
local orgUsed = tonumber(redis.call('GET', KEYS[3]) or '0') + redis.call('ZCARD', KEYS[4])
if orgUsed >= tonumber(ARGV[5]) then return 'WORKSPACE_CAP' end
if tonumber(redis.call('GET', KEYS[5]) or '0') >= tonumber(ARGV[6]) then return 'DOMAIN_LIMIT' end
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[7])
redis.call('ZADD', KEYS[4], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[4], ARGV[7])
redis.call('INCR', KEYS[5])
redis.call('EXPIRE', KEYS[5], 3600)
redis.call('SET', KEYS[6], ARGV[9], 'EX', ARGV[8])
return 'OK'
`;

// KEYS: token. Commit: the token's record is consumed once; the mailbox's and workspace's sent counts go up.
const COMMIT = `
local value = redis.call('GET', KEYS[1])
if not value then return false end
redis.call('DEL', KEYS[1])
local record = cjson.decode(value)
redis.call('ZREM', record.held, record.token)
redis.call('ZREM', record.orgHeld, record.token)
redis.call('INCR', record.sent)
redis.call('EXPIRE', record.sent, ${DAY_TTL})
redis.call('INCR', record.orgSent)
redis.call('EXPIRE', record.orgSent, ${DAY_TTL})
return value
`;

// KEYS: token. Release: the hold is dropped and the domain count given back.
const RELEASE = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
redis.call('DEL', KEYS[1])
local record = cjson.decode(value)
redis.call('ZREM', record.held, record.token)
redis.call('ZREM', record.orgHeld, record.token)
if tonumber(redis.call('GET', record.domain) or '0') > 0 then redis.call('DECR', record.domain) end
return 1
`;

interface TokenRecord {
  readonly token: string;
  readonly mailboxId: string;
  readonly day: string;
  readonly sent: string;
  readonly held: string;
  readonly orgSent: string;
  readonly orgHeld: string;
  readonly domain: string;
}

@Injectable()
export class ValkeyCapacityCounters implements CapacityCounters, RunLock {
  constructor(
    @Inject(VALKEY) private readonly valkey: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async reserve(input: ReserveInput) {
    const now = this.clock.now().getTime();
    const token = randomUUID();
    const record: TokenRecord = {
      token,
      mailboxId: input.mailboxId,
      day: input.day,
      sent: sentKey(input.mailboxId, input.day),
      held: heldKey(input.mailboxId, input.day),
      orgSent: orgSentKey(input.organizationId, input.workspaceDay),
      orgHeld: orgHeldKey(input.organizationId, input.workspaceDay),
      domain: domainKey(input.organizationId, input.recipientDomain, input.domainHour),
    };
    const result = (await this.valkey.eval(
      RESERVE,
      6,
      record.sent,
      record.held,
      record.orgSent,
      record.orgHeld,
      record.domain,
      tokenKey(token),
      String(now),
      String(now + input.ttlSeconds * 1000),
      token,
      String(input.cap),
      String(input.workspaceCap),
      String(input.domainLimit),
      String(DAY_TTL),
      String(input.ttlSeconds + 3600),
      JSON.stringify(record),
    )) as string;
    return result === 'OK'
      ? { ok: true as const, token }
      : { ok: false as const, reason: result as ReserveRefusal };
  }

  async commit(token: string) {
    const value = (await this.valkey.eval(COMMIT, 1, tokenKey(token))) as string | null;
    if (!value) return null;
    const record = JSON.parse(value) as TokenRecord;
    return { mailboxId: record.mailboxId, day: record.day };
  }

  async release(token: string) {
    return Number(await this.valkey.eval(RELEASE, 1, tokenKey(token))) === 1;
  }

  async seed(mailboxId: string, day: string, sent: number) {
    await this.valkey.set(sentKey(mailboxId, day), String(sent), 'EX', DAY_TTL, 'NX');
  }

  async today(mailboxId: string, day: string) {
    const now = this.clock.now().getTime();
    const [sent, reserved] = await Promise.all([
      this.valkey.get(sentKey(mailboxId, day)),
      this.valkey.zcount(heldKey(mailboxId, day), `(${now}`, '+inf'),
    ]);
    if (sent === null && reserved === 0) return null;
    return { sent: Number(sent ?? 0), reserved };
  }

  async lastSentAt(mailboxId: string) {
    const value = await this.valkey.get(lastSentKey(mailboxId));
    return value ? new Date(Number(value)) : null;
  }

  async noteSent(mailboxId: string, at: Date) {
    await this.valkey.set(lastSentKey(mailboxId), String(at.getTime()), 'EX', DAY_TTL);
  }

  async acquire(name: string, ttlSeconds: number) {
    return (
      (await this.valkey.set(`${PREFIX}:lock:${name}`, '1', 'EX', Math.max(1, ttlSeconds), 'NX')) === 'OK'
    );
  }
}
