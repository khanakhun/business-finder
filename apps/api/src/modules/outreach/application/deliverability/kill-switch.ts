import { type KillSwitch, type SetKillSwitchRequest, SetKillSwitchRequestSchema } from '@bf/contracts';
import { metrics } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Transactional } from '../../../platform/db/transactional.ts';
import { VALKEY } from '../../../platform/valkey/valkey.module.ts';
import { RealtimePublisher } from '../../../realtime/index.ts';
import { AuditLogger } from '../../../workspace/index.ts';
import { SEQUENCE_REPOSITORY, type SequenceRepository } from '../sequences/ports.ts';
import { DELIVERABILITY_REPOSITORY, type DeliverabilityRepository } from './ports.ts';

// The workspace kill switch (BF-056): "stop all sending". The flag lives in the database and in Valkey, which every
// send attempt reads before talking to a provider — so it takes effect within seconds on every worker. Turning it on
// pauses the workspace's sequences (reason `kill_switch`); turning it off resumes those. Both ways need a reason and
// are audited; the app shows a banner while it is on.

const KEY = (organizationId: string) => `bf:outreach:kill:${organizationId}`;
const CACHE_SECONDS = 30;
const REASON = 'kill_switch';
export const KILL_SWITCH_CHANGED = 'outreach.kill_switch.changed';

const gauge = () =>
  metrics.gauge({
    name: 'bf_outreach_kill_switch_active',
    help: 'Workspaces with sending stopped by the kill switch',
  });

@Injectable()
export class KillSwitchService {
  constructor(
    @Inject(DELIVERABILITY_REPOSITORY) private readonly repository: DeliverabilityRepository,
    @Inject(SEQUENCE_REPOSITORY) private readonly sequences: SequenceRepository,
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly audit: AuditLogger,
    private readonly realtime: RealtimePublisher,
  ) {}

  async get(organizationId: string): Promise<KillSwitch> {
    const row = await this.repository.killSwitch(organizationId);
    return { active: row.active, reason: row.reason, by: row.by, at: row.at?.toISOString() ?? null };
  }

  /** Read before every send: the cache, else the database (and the cache is refilled). */
  async isActive(organizationId: string): Promise<boolean> {
    const cached = await this.valkey.get(KEY(organizationId)).catch(() => null);
    if (cached !== null) return cached === '1';
    const { active } = await this.repository.killSwitch(organizationId);
    await this.valkey
      .set(KEY(organizationId), active ? '1' : '0', 'EX', CACHE_SECONDS)
      .catch(() => undefined);
    return active;
  }

  @Transactional()
  async set(organizationId: string, userId: string | null, input: SetKillSwitchRequest): Promise<KillSwitch> {
    const request = SetKillSwitchRequestSchema.parse(input);
    await this.repository.setKillSwitch(organizationId, request.active, request.reason, userId);
    // Effective at once: the cache says so before the transaction's other work.
    await this.valkey.set(KEY(organizationId), request.active ? '1' : '0', 'EX', CACHE_SECONDS);
    const sequences = request.active
      ? await this.sequences.pauseAll(organizationId, REASON)
      : await this.sequences.resumeAll(organizationId, REASON);
    await this.audit.record({
      action: request.active ? 'deliverability.kill_switch_on' : 'deliverability.kill_switch_off',
      organizationId,
      entityType: 'workspace',
      entityId: organizationId,
      metadata: { reason: request.reason, sequences },
    });
    gauge().inc(request.active ? 1 : -1);
    await this.realtime.publish(organizationId, {
      type: KILL_SWITCH_CHANGED,
      entity: 'workspace',
      entityId: organizationId,
      payload: { active: request.active },
    });
    return this.get(organizationId);
  }
}
