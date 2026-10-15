import {
  type AiCache,
  type AiProvider,
  type BudgetGuard,
  type BudgetState,
  type KeyResolver,
  PROVIDER_SECRETS,
} from '@bf/ai';
import { AiBudgetSoftLimitReached, type Clock, SecretNameSchema } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import type { Redis } from 'ioredis';
import { SecretResolver } from '../../workspace/index.ts';
import type { EventRecorder } from '../events/event-recorder.ts';
import type { LlmCallRepository } from './llm-call.repository.ts';

/** Provider keys from the workspace vault, then the deployment env (BF-011 `SecretResolver`). */
export function vaultKeyResolver(secrets: SecretResolver): KeyResolver {
  return {
    async resolve(orgId: string | null, provider: AiProvider) {
      return (await secrets.resolve(orgId, SecretNameSchema.parse(PROVIDER_SECRETS[provider])))?.value;
    },
  };
}

/** Response and embedding cache in Valkey (fails open: a Valkey error is a cache miss). */
export function valkeyAiCache(valkey: Redis): AiCache {
  return {
    async get(key) {
      return (await valkey.get(key)) ?? undefined;
    },
    async set(key, value, ttlSeconds) {
      await valkey.set(key, value, 'EX', ttlSeconds);
    },
  };
}

export const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const monthKey = (now: Date) => now.toISOString().slice(0, 7);

/**
 * Monthly spend per workspace from the ledger (cached briefly in memory so every call does not sum the month),
 * compared with AI_BUDGET_MONTHLY_SOFT_USD / _HARD_USD.
 */
export class LedgerBudgetGuard implements BudgetGuard {
  private readonly cache = new Map<string, { readonly spent: number; readonly at: number }>();

  constructor(
    private readonly ledger: Pick<LlmCallRepository, 'spentSince'>,
    private readonly limits: { readonly softUsd: number; readonly hardUsd: number },
    private readonly clock: Clock,
    private readonly ttlMs = 60_000,
  ) {}

  async spent(orgId: string): Promise<number> {
    const now = this.clock.now();
    const cached = this.cache.get(orgId);
    if (cached && now.getTime() - cached.at < this.ttlMs) return cached.spent;
    const spent = await this.ledger.spentSince(orgId, monthStart(now));
    this.cache.set(orgId, { spent, at: now.getTime() });
    return spent;
  }

  async check(orgId: string): Promise<BudgetState> {
    const spent = await this.spent(orgId);
    if (spent >= this.limits.hardUsd) return 'hard';
    if (spent >= this.limits.softUsd) return 'soft';
    return 'ok';
  }
}

/** Records `ai.budget_soft_limit_reached` once per workspace and month (Valkey SET NX). */
export function softBudgetNotifier(deps: {
  readonly valkey: Redis;
  readonly events: EventRecorder;
  readonly budget: LedgerBudgetGuard;
  readonly softUsd: number;
  readonly clock: Clock;
  readonly logger: Logger;
}): (orgId: string, task: string) => void {
  return (orgId, task) => {
    const month = monthKey(deps.clock.now());
    void (async () => {
      const first = await deps.valkey.set(
        `bf:ai:budget-soft:${orgId}:${month}`,
        '1',
        'EX',
        40 * 24 * 3600,
        'NX',
      );
      if (first !== 'OK') return;
      const spentUsd = await deps.budget.spent(orgId);
      deps.logger.warn({ orgId, task, spentUsd }, 'workspace passed its soft AI budget');
      await deps.events.record(AiBudgetSoftLimitReached, {
        payload: { month, spentUsd, softLimitUsd: deps.softUsd },
        orgId,
        actor: { type: 'system', id: null },
      });
    })().catch((error: unknown) =>
      deps.logger.warn({ err: error, orgId }, 'could not record the soft budget event'),
    );
  };
}
