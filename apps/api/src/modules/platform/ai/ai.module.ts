import {
  type AiGateway,
  createAiGateway,
  type ModelFactory,
  providerModels,
  registerAiTelemetry,
} from '@bf/ai';
import type { ApiEnv } from '@bf/config';
import type { Clock } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { SecretResolver } from '../../workspace/index.ts';
import { CLOCK } from '../clock/clock.module.ts';
import { APP_ENV, type AppEnv, type AppMode } from '../config/app-env.ts';
import { EventRecorder } from '../events/event-recorder.ts';
import { LOGGER } from '../logging/logger.ts';
import { VALKEY } from '../valkey/valkey.module.ts';
import { LedgerBudgetGuard, softBudgetNotifier, valkeyAiCache, vaultKeyResolver } from './ai-adapters.ts';
import { LlmCallRepository } from './llm-call.repository.ts';
import { AiUsageController } from './usage.controller.ts';

/** The LLM gateway for feature modules: `@Inject(AI_GATEWAY) ai: AiGateway`. */
export const AI_GATEWAY = Symbol('AI_GATEWAY');
/** How models are built (real providers; tests override it with mock models). */
export const AI_MODEL_FACTORY = Symbol('AI_MODEL_FACTORY');
export const AI_BUDGET_GUARD = Symbol('AI_BUDGET_GUARD');

/**
 * AI platform (BF-013): `@bf/ai` wired with the workspace vault (keys), Valkey (cache), the `llm_calls` ledger,
 * monthly budgets and tracing. Every process may run AI tasks; the HTTP process also serves `GET /v1/ai/usage`.
 */
@Global()
@Module({})
export class AiModule {
  static forRoot(mode: AppMode): DynamicModule {
    // AI SDK spans (provider calls, tokens) as OpenTelemetry spans, exported with the rest (and to Langfuse).
    registerAiTelemetry();
    return {
      module: AiModule,
      controllers: mode === 'worker' ? [] : [AiUsageController],
      providers: [
        LlmCallRepository,
        { provide: AI_MODEL_FACTORY, useValue: providerModels },
        {
          provide: AI_BUDGET_GUARD,
          inject: [LlmCallRepository, APP_ENV, CLOCK],
          useFactory: (ledger: LlmCallRepository, env: AppEnv, clock: Clock) =>
            new LedgerBudgetGuard(
              ledger,
              {
                softUsd: (env as ApiEnv).AI_BUDGET_MONTHLY_SOFT_USD,
                hardUsd: (env as ApiEnv).AI_BUDGET_MONTHLY_HARD_USD,
              },
              clock,
            ),
        },
        {
          provide: AI_GATEWAY,
          inject: [
            APP_ENV,
            SecretResolver,
            LlmCallRepository,
            AI_BUDGET_GUARD,
            AI_MODEL_FACTORY,
            VALKEY,
            EventRecorder,
            CLOCK,
            LOGGER,
          ],
          useFactory: (
            appEnv: AppEnv,
            secrets: SecretResolver,
            ledger: LlmCallRepository,
            budget: LedgerBudgetGuard,
            models: ModelFactory,
            valkey: Redis,
            events: EventRecorder,
            clock: Clock,
            logger: Logger,
          ): AiGateway => {
            const env = appEnv as ApiEnv;
            return createAiGateway({
              routing: {
                tiers: { fast: env.AI_MODEL_FAST, smart: env.AI_MODEL_SMART, agent: env.AI_MODEL_AGENT },
                overrides: env.AI_MODEL_OVERRIDES,
                fallbacks: env.AI_MODEL_FALLBACKS,
                embeddingModel: env.AI_EMBEDDING_MODEL,
              },
              keys: vaultKeyResolver(secrets),
              pricing: env.AI_PRICING,
              cache: valkeyAiCache(valkey),
              recorder: ledger,
              budget,
              onSoftBudget: softBudgetNotifier({
                valkey,
                events,
                budget,
                softUsd: env.AI_BUDGET_MONTHLY_SOFT_USD,
                clock,
                logger,
              }),
              models,
              traceContent: env.AI_TRACE_CONTENT,
              onUnpricedModel: (model) =>
                logger.warn(
                  { model },
                  'no AI_PRICING entry for this model: its calls cost null and escape budgets',
                ),
            });
          },
        },
      ],
      exports: [AI_GATEWAY, LlmCallRepository],
    };
  }
}
