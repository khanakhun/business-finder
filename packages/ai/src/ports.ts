import type { AiProvider } from './routing.ts';

/** Resolves the API key a workspace uses for a provider (vault, then deployment env — BF-011). */
export interface KeyResolver {
  resolve(orgId: string | null, provider: AiProvider): Promise<string | undefined>;
}

/** Response cache (Valkey in the API). Values are JSON strings. */
export interface AiCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export type BudgetState = 'ok' | 'soft' | 'hard';

/** Monthly spend of a workspace against its soft and hard limits. */
export interface BudgetGuard {
  check(orgId: string): Promise<BudgetState>;
}

export interface LlmCall {
  readonly orgId: string | null;
  readonly task: string;
  readonly promptVersion: number | null;
  readonly provider: AiProvider;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly status: 'ok' | 'cached' | 'error';
  readonly errorCode: string | null;
  readonly traceId: string | null;
}

/** The `llm_calls` ledger. Recording must never fail the call (adapters swallow and log). */
export interface LlmCallRecorder {
  record(call: LlmCall): Promise<void>;
}
