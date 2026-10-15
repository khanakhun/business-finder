import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { BudgetExceededError } from '@bf/contracts';
import {
  APICallError,
  type EmbeddingModel,
  embedMany,
  generateText,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  streamText,
} from 'ai';
import type { z } from 'zod';
import { embeddingCacheKey, responseCacheKey } from './cache.ts';
import { addUsage, costUsd, type ModelPricing, type TokenUsage, ZERO_USAGE } from './cost.ts';
import type { AiTask, ObjectTask, TextTask, VisionTask } from './define-task.ts';
import { AiOutputInvalidError, AiProviderNotConfiguredError, AiProviderUnavailableError } from './errors.ts';
import type { AiCache, BudgetGuard, KeyResolver, LlmCall, LlmCallRecorder } from './ports.ts';
import { loadPromptRegistry, type PromptRegistry } from './prompts/registry.ts';
import {
  DEFAULT_RESILIENCE,
  isBrokenCircuit,
  isRetryableProviderError,
  ProviderPolicies,
  type ResilienceConfig,
} from './resilience.ts';
import { type AiProvider, type ModelRef, parseModelRef, type RoutingConfig, routeFor } from './routing.ts';
import { activeTraceId, sdkTelemetry, withTaskSpan } from './telemetry.ts';
import {
  type AiImage,
  DEFAULT_MAX_IMAGE_DIMENSION,
  MAX_IMAGES_PER_CALL,
  type PreparedImage,
  prepareImage,
} from './vision.ts';

export interface AiContext {
  /** The workspace the call is for: keys, budget, cache scope and the ledger depend on it. */
  readonly orgId: string | null;
  readonly signal?: AbortSignal;
}

export interface AiResult<T> {
  readonly output: T;
  readonly provider: AiProvider;
  readonly model: string;
  readonly promptVersion: number;
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly cached: boolean;
  readonly latencyMs: number;
}

export interface AiStream {
  readonly textStream: AsyncIterable<string>;
  /** Settles when the stream ends (and the call is recorded). */
  readonly result: Promise<AiResult<string>>;
}

export interface EmbedOptions {
  /** What the vectors are for (ledger and telemetry), e.g. `business.search`. */
  readonly purpose: string;
  readonly orgId: string | null;
  readonly signal?: AbortSignal;
}

export interface EmbedResult {
  readonly vectors: number[][];
  readonly model: string;
  readonly dims: number;
}

type OutputOf<T extends AiTask> =
  T extends ObjectTask<z.ZodType, infer O>
    ? z.output<O>
    : T extends VisionTask<z.ZodType, infer O>
      ? z.output<O>
      : string;

/** The only way feature code talks to models (ADR-0011). */
export interface AiGateway {
  run<T extends ObjectTask | TextTask>(
    task: T,
    input: z.input<T['input']>,
    ctx: AiContext,
  ): Promise<AiResult<OutputOf<T>>>;
  stream<T extends TextTask>(task: T, input: z.input<T['input']>, ctx: AiContext): Promise<AiStream>;
  embed(texts: readonly string[], options: EmbedOptions): Promise<EmbedResult>;
  vision<T extends VisionTask>(
    task: T,
    request: { readonly input: z.input<T['input']>; readonly images: readonly AiImage[] },
    ctx: AiContext,
  ): Promise<AiResult<OutputOf<T>>>;
}

/** Builds AI SDK models from a reference and a key (Strategy; tests pass mock models). */
export interface ModelFactory {
  language(ref: ModelRef, apiKey: string): LanguageModel;
  embedding(ref: ModelRef, apiKey: string): EmbeddingModel;
}

export const providerModels: ModelFactory = {
  // Provider instances are created per call: keys differ per workspace.
  language: (ref, apiKey) =>
    ref.provider === 'anthropic'
      ? createAnthropic({ apiKey })(ref.model)
      : createOpenAI({ apiKey })(ref.model),
  embedding: (ref, apiKey) => {
    if (ref.provider !== 'openai') throw new Error(`No embedding models are wired for ${ref.provider}`);
    return createOpenAI({ apiKey }).embedding(ref.model);
  },
};

/** Secret registry keys (`SECRET_DEFINITIONS` in @bf/contracts) holding each provider's API key. */
export const PROVIDER_SECRETS: Readonly<Record<AiProvider, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
};

export interface AiGatewayOptions {
  readonly routing: RoutingConfig;
  readonly keys: KeyResolver;
  readonly prompts?: PromptRegistry;
  readonly pricing?: ModelPricing;
  readonly cache?: AiCache;
  readonly recorder?: LlmCallRecorder;
  readonly budget?: BudgetGuard;
  /** Called when a workspace passes its soft budget (e.g. to record a warning event). */
  readonly onSoftBudget?: (orgId: string, task: string) => void;
  /** Called once per model without a price in `pricing`: its calls cost null and escape budgets. */
  readonly onUnpricedModel?: (model: string) => void;
  readonly models?: ModelFactory;
  readonly resilience?: ResilienceConfig;
  /** Send prompt and response bodies to tracing (Langfuse). Off by default: they may contain personal data. */
  readonly traceContent?: boolean;
  readonly embeddingBatchSize?: number;
  readonly embeddingCacheTtlSeconds?: number;
}

const toUsage = (usage: LanguageModelUsage | undefined): TokenUsage => ({
  inputTokens: usage?.inputTokens ?? 0,
  outputTokens: usage?.outputTokens ?? 0,
  cachedTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
});

const isInvalidOutput = (error: unknown) =>
  NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error);

/** A provider-side failure worth trying the next model for (outage, rate limit, auth, bad request). */
const isProviderFailure = (error: unknown) =>
  isRetryableProviderError(error) || isBrokenCircuit(error) || APICallError.isInstance(error);

const errorCode = (error: unknown): string => {
  if (error instanceof AiOutputInvalidError) return 'AI_OUTPUT_INVALID';
  if (error instanceof AiProviderNotConfiguredError) return 'AI_PROVIDER_NOT_CONFIGURED';
  if (APICallError.isInstance(error)) return `HTTP_${error.statusCode ?? 'ERROR'}`;
  if (isBrokenCircuit(error)) return 'CIRCUIT_OPEN';
  return error instanceof Error ? error.name : 'UNKNOWN';
};

interface Attempt<T> {
  readonly output: T;
  readonly ref: ModelRef;
  readonly usage: TokenUsage;
}

/** Facade over the AI SDK with Decorator-style concerns: budget → cache → fallback chain → retry/breaker → ledger. */
export function createAiGateway(options: AiGatewayOptions): AiGateway {
  const prompts = options.prompts ?? loadPromptRegistry();
  const models = options.models ?? providerModels;
  const policies = new ProviderPolicies(options.resilience ?? DEFAULT_RESILIENCE);
  const pricing = options.pricing ?? {};
  const traceContent = options.traceContent ?? false;

  const unpriced = new Set<string>();
  /** Cost of a call; unpriced models are reported once (their spend escapes budgets until priced). */
  function price(model: string, usage: TokenUsage): number | null {
    const cost = costUsd(pricing, model, usage);
    if (cost === null && !unpriced.has(model)) {
      unpriced.add(model);
      options.onUnpricedModel?.(model);
    }
    return cost;
  }

  async function record(call: LlmCall): Promise<void> {
    try {
      await options.recorder?.record(call);
    } catch {
      // The ledger must never fail a call; adapters log their own errors.
    }
  }

  async function enforceBudget(task: AiTask, ctx: AiContext): Promise<void> {
    if (!options.budget || !ctx.orgId) return;
    const state = await options.budget.check(ctx.orgId);
    if (state === 'hard' && !task.essential) {
      throw new BudgetExceededError('The workspace reached its monthly AI budget.', {
        details: { reason: 'AI_BUDGET_EXCEEDED', task: task.name },
      });
    }
    if (state !== 'ok') options.onSoftBudget?.(ctx.orgId, task.name);
  }

  const signalFor = (task: AiTask, ctx: AiContext, policySignal: AbortSignal) =>
    AbortSignal.any([policySignal, AbortSignal.timeout(task.timeoutMs), ...(ctx.signal ? [ctx.signal] : [])]);

  /** Tries each configured model of the chain; output errors stop the chain, provider errors move to the next. */
  async function withFallback<T>(
    task: AiTask,
    ctx: AiContext,
    attempt: (ref: ModelRef, apiKey: string) => Promise<Attempt<T>>,
  ): Promise<Attempt<T>> {
    const chain = routeFor(task, options.routing);
    let lastError: unknown;
    let configured = false;
    for (const ref of chain) {
      const apiKey = await options.keys.resolve(ctx.orgId, ref.provider);
      if (!apiKey) continue;
      configured = true;
      try {
        return await attempt(ref, apiKey);
      } catch (error) {
        if (!isProviderFailure(error)) throw error;
        lastError = error;
      }
    }
    const primary = chain[0] as ModelRef;
    if (!configured)
      throw new AiProviderNotConfiguredError(primary.provider, PROVIDER_SECRETS[primary.provider]);
    throw new AiProviderUnavailableError(task.name, lastError);
  }

  /** One model, with retries and the provider's breaker; structured output gets one repair round. */
  async function generate<T>(
    task: ObjectTask | TextTask | VisionTask,
    ref: ModelRef,
    apiKey: string,
    ctx: AiContext,
    system: string,
    messages: ModelMessage[],
  ): Promise<Attempt<T>> {
    const model = models.language(ref, apiKey);
    const call = (conversation: ModelMessage[]) =>
      policies.for(ref.provider).execute(({ signal }) =>
        generateText({
          model,
          system,
          messages: conversation,
          ...(task.kind === 'text' ? {} : { output: Output.object({ schema: task.output }) }),
          ...(task.temperature === undefined ? {} : { temperature: task.temperature }),
          maxOutputTokens: task.maxOutputTokens,
          abortSignal: signalFor(task, ctx, signal),
          // Retries are ours (jitter + breaker per provider).
          maxRetries: 0,
          // Image URLs go to the provider as URLs: this process never fetches them (SSRF; AGENTS.md §8).
          experimental_download: async (requested) => requested.map(() => null),
          telemetry: sdkTelemetry(task.name, traceContent),
        }),
      );
    try {
      const result = await call(messages);
      return {
        output: (task.kind === 'text' ? result.text : result.output) as T,
        ref,
        usage: toUsage(result.usage),
      };
    } catch (error) {
      if (task.kind === 'text' || !isInvalidOutput(error)) throw error;
      // Repair round: show the model its answer and the validation error, once.
      const failed = error as NoObjectGeneratedError;
      const repairMessages: ModelMessage[] = [
        ...messages,
        { role: 'assistant', content: failed.text ?? '' },
        {
          role: 'user',
          content: `Your previous answer did not match the required JSON schema: ${
            failed.cause instanceof Error ? failed.cause.message : failed.message
          }\nReply again with only JSON that matches the schema.`,
        },
      ];
      try {
        const repaired = await call(repairMessages);
        return {
          output: repaired.output as T,
          ref,
          usage: addUsage(toUsage(failed.usage), toUsage(repaired.usage)),
        };
      } catch (repairError) {
        if (!isInvalidOutput(repairError)) throw repairError;
        const invalid = new AiOutputInvalidError(task.name, repairError);
        invalid.usage = addUsage(
          toUsage(failed.usage),
          toUsage((repairError as NoObjectGeneratedError).usage),
        );
        invalid.model = ref;
        throw invalid;
      }
    }
  }

  async function execute<T>(
    task: ObjectTask | TextTask | VisionTask,
    rawInput: unknown,
    ctx: AiContext,
    images: readonly AiImage[] = [],
  ): Promise<AiResult<T>> {
    const input = task.input.parse(rawInput);
    await enforceBudget(task, ctx);
    const prompt = prompts.get(task.prompt);
    const rendered = prompt.render((task.variables?.(input) ?? input) as Record<string, unknown>);
    const [primary] = routeFor(task, options.routing);
    if (!primary) throw new Error(`No model routed for ${task.name}`);
    const attributes = { 'ai.task': task.name, 'ai.prompt.version': prompt.version, 'ai.tier': task.tier };
    return withTaskSpan(task.name, attributes, async (span) => {
      const started = performance.now();
      const base = {
        orgId: ctx.orgId,
        task: task.name,
        promptVersion: prompt.version,
        traceId: activeTraceId(span),
      };
      const cacheKey =
        options.cache && task.cacheTtlSeconds && images.length === 0
          ? responseCacheKey({
              task: task.name,
              promptVersion: prompt.version,
              model: `${primary.provider}:${primary.model}`,
              input,
              orgScope: task.cacheScope === 'global' ? null : ctx.orgId,
            })
          : undefined;
      if (cacheKey) {
        const hit = await options.cache?.get(cacheKey).catch(() => undefined);
        if (hit) {
          const cached = JSON.parse(hit) as { output: unknown; provider: AiProvider; model: string };
          const output = (
            task.kind === 'text' ? String(cached.output) : task.output.parse(cached.output)
          ) as T;
          const latencyMs = Math.round(performance.now() - started);
          await record({
            ...base,
            provider: cached.provider,
            model: cached.model,
            ...ZERO_USAGE,
            costUsd: 0,
            latencyMs,
            status: 'cached',
            errorCode: null,
          });
          return {
            output,
            provider: cached.provider,
            model: cached.model,
            promptVersion: prompt.version,
            usage: ZERO_USAGE,
            costUsd: 0,
            cached: true,
            latencyMs,
          };
        }
      }

      if (images.length > MAX_IMAGES_PER_CALL)
        throw new Error(`At most ${MAX_IMAGES_PER_CALL} images per call`);
      // One at a time: decoding large images in parallel multiplies memory.
      const prepared: PreparedImage[] = [];
      for (const image of images) {
        prepared.push(
          await prepareImage(
            image,
            (task.kind === 'vision' ? task.maxImageDimension : undefined) ?? DEFAULT_MAX_IMAGE_DIMENSION,
          ),
        );
      }
      const messages: ModelMessage[] = [
        prepared.length === 0
          ? { role: 'user', content: rendered.user }
          : {
              role: 'user',
              content: [
                { type: 'text', text: rendered.user },
                // AI SDK 7: images are `file` parts with an image media type (`image` parts are deprecated).
                ...prepared.map((image) => ({
                  type: 'file' as const,
                  data: image.image,
                  mediaType: image.mediaType ?? 'image',
                })),
              ],
            },
      ];
      try {
        const attempt = await withFallback<T>(task, ctx, (ref, apiKey) =>
          generate<T>(task, ref, apiKey, ctx, rendered.system, messages),
        );
        const latencyMs = Math.round(performance.now() - started);
        const cost = price(attempt.ref.model, attempt.usage);
        span.setAttributes({
          'ai.model': attempt.ref.model,
          'ai.usage.input_tokens': attempt.usage.inputTokens,
          'ai.usage.output_tokens': attempt.usage.outputTokens,
          ...(cost === null ? {} : { 'ai.cost_usd': cost }),
        });
        await record({
          ...base,
          provider: attempt.ref.provider,
          model: attempt.ref.model,
          ...attempt.usage,
          costUsd: cost,
          latencyMs,
          status: 'ok',
          errorCode: null,
        });
        if (cacheKey && task.cacheTtlSeconds) {
          const value = JSON.stringify({
            output: attempt.output,
            provider: attempt.ref.provider,
            model: attempt.ref.model,
          });
          await options.cache?.set(cacheKey, value, task.cacheTtlSeconds).catch(() => undefined);
        }
        return {
          output: attempt.output,
          provider: attempt.ref.provider,
          model: attempt.ref.model,
          promptVersion: prompt.version,
          usage: attempt.usage,
          costUsd: cost,
          cached: false,
          latencyMs,
        };
      } catch (error) {
        // Billed tokens of failed attempts still count (ledger and budgets).
        const billed = error instanceof AiOutputInvalidError ? error : undefined;
        const ref = billed?.model ?? primary;
        const usage = billed?.usage ?? ZERO_USAGE;
        await record({
          ...base,
          provider: ref.provider,
          model: ref.model,
          ...usage,
          costUsd: billed?.usage ? price(ref.model, usage) : null,
          latencyMs: Math.round(performance.now() - started),
          status: 'error',
          errorCode: errorCode(error),
        });
        throw error;
      }
    });
  }

  return {
    run: (task, input, ctx) => execute(task, input, ctx),

    vision: (task, request, ctx) => execute(task, request.input, ctx, request.images),

    async stream(task, rawInput, ctx) {
      const input = task.input.parse(rawInput);
      await enforceBudget(task, ctx);
      const prompt = prompts.get(task.prompt);
      const rendered = prompt.render((task.variables?.(input) ?? input) as Record<string, unknown>);
      const [ref] = routeFor(task, options.routing);
      if (!ref) throw new Error(`No model routed for ${task.name}`);
      const apiKey = await options.keys.resolve(ctx.orgId, ref.provider);
      if (!apiKey) throw new AiProviderNotConfiguredError(ref.provider, PROVIDER_SECRETS[ref.provider]);
      const started = performance.now();
      const stream = streamText({
        model: models.language(ref, apiKey),
        system: rendered.system,
        messages: [{ role: 'user', content: rendered.user }],
        ...(task.temperature === undefined ? {} : { temperature: task.temperature }),
        maxOutputTokens: task.maxOutputTokens,
        abortSignal: AbortSignal.any([
          AbortSignal.timeout(task.timeoutMs),
          ...(ctx.signal ? [ctx.signal] : []),
        ]),
        telemetry: sdkTelemetry(task.name, traceContent),
      });
      const base = { orgId: ctx.orgId, task: task.name, promptVersion: prompt.version, traceId: null };
      const result = (async (): Promise<AiResult<string>> => {
        try {
          const [text, usage] = await Promise.all([stream.text, stream.usage]);
          const tokens = toUsage(usage);
          const latencyMs = Math.round(performance.now() - started);
          const cost = price(ref.model, tokens);
          await record({
            ...base,
            provider: ref.provider,
            model: ref.model,
            ...tokens,
            costUsd: cost,
            latencyMs,
            status: 'ok',
            errorCode: null,
          });
          return {
            output: text,
            provider: ref.provider,
            model: ref.model,
            promptVersion: prompt.version,
            usage: tokens,
            costUsd: cost,
            cached: false,
            latencyMs,
          };
        } catch (error) {
          await record({
            ...base,
            provider: ref.provider,
            model: ref.model,
            ...ZERO_USAGE,
            costUsd: null,
            latencyMs: Math.round(performance.now() - started),
            status: 'error',
            errorCode: errorCode(error),
          });
          throw error;
        }
      })();
      // Nobody may await `result`: avoid an unhandled rejection; callers still see the error when they do.
      result.catch(() => undefined);
      return { textStream: stream.textStream, result };
    },

    async embed(texts, embedOptions) {
      const ref = parseModelRef(options.routing.embeddingModel);
      const apiKey = await options.keys.resolve(embedOptions.orgId, ref.provider);
      if (!apiKey) throw new AiProviderNotConfiguredError(ref.provider, PROVIDER_SECRETS[ref.provider]);
      const started = performance.now();
      const vectors: Array<number[] | undefined> = new Array(texts.length);
      const misses: number[] = [];
      for (const [index, text] of texts.entries()) {
        const hit = options.cache
          ? await options.cache.get(embeddingCacheKey(ref.model, text)).catch(() => undefined)
          : undefined;
        if (hit) vectors[index] = JSON.parse(hit) as number[];
        else misses.push(index);
      }
      const batchSize = options.embeddingBatchSize ?? 96;
      let tokens = 0;
      const model = models.embedding(ref, apiKey);
      try {
        for (let offset = 0; offset < misses.length; offset += batchSize) {
          const batch = misses.slice(offset, offset + batchSize);
          const result = await policies.for(ref.provider).execute(({ signal }) =>
            embedMany({
              model,
              values: batch.map((index) => texts[index] as string),
              maxRetries: 0,
              abortSignal: AbortSignal.any([signal, ...(embedOptions.signal ? [embedOptions.signal] : [])]),
              telemetry: {
                functionId: `embed.${embedOptions.purpose}`,
                recordInputs: false,
                recordOutputs: false,
              },
            }),
          );
          tokens += result.usage.tokens;
          for (const [position, index] of batch.entries()) {
            const vector = result.embeddings[position] as number[];
            vectors[index] = vector;
            await options.cache
              ?.set(
                embeddingCacheKey(ref.model, texts[index] as string),
                JSON.stringify(vector),
                options.embeddingCacheTtlSeconds ?? 30 * 24 * 3600,
              )
              .catch(() => undefined);
          }
        }
      } catch (error) {
        await record({
          orgId: embedOptions.orgId,
          task: `embed.${embedOptions.purpose}`,
          promptVersion: null,
          provider: ref.provider,
          model: ref.model,
          ...ZERO_USAGE,
          costUsd: null,
          latencyMs: Math.round(performance.now() - started),
          status: 'error',
          errorCode: errorCode(error),
          traceId: null,
        });
        throw error;
      }
      const usage = { inputTokens: tokens, outputTokens: 0, cachedTokens: 0 };
      await record({
        orgId: embedOptions.orgId,
        task: `embed.${embedOptions.purpose}`,
        promptVersion: null,
        provider: ref.provider,
        model: ref.model,
        ...usage,
        costUsd: price(ref.model, usage),
        latencyMs: Math.round(performance.now() - started),
        status: misses.length === 0 ? 'cached' : 'ok',
        errorCode: null,
        traceId: null,
      });
      const complete = vectors as number[][];
      return { vectors: complete, model: ref.model, dims: complete[0]?.length ?? 0 };
    },
  };
}
