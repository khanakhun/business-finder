import { createHash } from 'node:crypto';
import type { BudgetGuard, LlmCallRecorder, PromptRegistry } from '@bf/ai';
import { ExternalServiceError, type GenerateSiteAssetsRequest } from '@bf/contracts';
import type { Redis } from 'ioredis';
import sharp from 'sharp';
import { z } from 'zod';
import { executeWithSignal, policyFor } from '../../../platform/resilience/resilience.ts';
import type { SecretResolver } from '../../../workspace/index.ts';
import { type AiImageAllowance, type ImageGenerator, sizeForAspect } from '../../application/stock-and-ai.ts';

// AI images (BF-038): OpenAI's image API behind the `ImageGenerator` port (the prompt rendered from the versioned
// `assets.ai_image.v1` file, the person's words as the scene only), a deterministic fake for tests and E2E, and the
// allowance: the workspace's AI budget, a daily image cap in Valkey and the `llm_calls` ledger.

const ImagesResponse = z.object({
  data: z
    .array(z.object({ b64_json: z.string().min(1) }))
    .min(1)
    .max(4),
});

export class OpenAiImageGenerator implements ImageGenerator {
  constructor(
    readonly model: string,
    private readonly secrets: Pick<SecretResolver, 'resolve'>,
    private readonly prompts: PromptRegistry,
  ) {}

  async available(organizationId: string) {
    return (await this.secrets.resolve(organizationId, 'openai')) !== undefined;
  }

  async generate(input: Parameters<ImageGenerator['generate']>[0]): Promise<readonly Buffer[]> {
    const key = (await this.secrets.resolve(input.organizationId, 'openai'))?.value;
    if (!key) throw new ExternalServiceError('openai', 'No OpenAI key for image generation');
    const rendered = this.prompts
      .get('assets.ai_image.v1')
      .render({ subject: input.prompt, style: 'natural' });
    const body = JSON.stringify({
      model: this.model,
      prompt: `${rendered.system}\n\n${rendered.user}`,
      n: input.count,
      size: sizeForAspect(input.aspect),
      quality: 'medium',
    });
    return executeWithSignal(policyFor('ai-image'), undefined, async (signal) => {
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        signal,
      });
      if (!response.ok) {
        // A refused prompt (its moderation) is not retried; other errors report the status only.
        throw new ExternalServiceError('openai', `images answered ${response.status}`, {
          details: { retryable: response.status >= 500 },
        });
      }
      const parsed = ImagesResponse.safeParse(await response.json());
      if (!parsed.success) throw new ExternalServiceError('openai', 'images returned an unexpected body');
      return parsed.data.data.map((image) => Buffer.from(image.b64_json, 'base64'));
    });
  }
}

/** Gradients from the prompt's hash (tests and E2E; no network, no cost). */
export class FakeImageGenerator implements ImageGenerator {
  readonly model = 'fake-image';

  async available() {
    return true;
  }

  async generate(input: Parameters<ImageGenerator['generate']>[0]): Promise<readonly Buffer[]> {
    const [width, height] = sizeForAspect(input.aspect as GenerateSiteAssetsRequest['aspect'])
      .split('x')
      .map((value) => Math.round(Number(value) / 2)) as [number, number];
    const out: Buffer[] = [];
    for (let index = 0; index < input.count; index++) {
      const digest = createHash('sha256').update(`${input.prompt}#${index}`).digest();
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgb(${digest[0]},${digest[1]},${digest[2]})"/><stop offset="1" stop-color="rgb(${digest[3]},${digest[4]},${digest[5]})"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
      out.push(await sharp(Buffer.from(svg)).png().toBuffer());
    }
    return out;
  }
}

/** The workspace's budget (the gateway's guard), a daily cap counted in Valkey, and the ledger. */
export class LedgerAiImageAllowance implements AiImageAllowance {
  constructor(
    private readonly budgetGuard: BudgetGuard,
    private readonly ledger: LlmCallRecorder,
    private readonly valkey: Pick<Redis, 'get' | 'incrby' | 'decrby' | 'expire'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  budget(organizationId: string) {
    return this.budgetGuard.check(organizationId);
  }

  private key(organizationId: string) {
    return `bf:ai-images:${organizationId}:${this.now().toISOString().slice(0, 10)}`;
  }

  async usedToday(organizationId: string) {
    return Number((await this.valkey.get(this.key(organizationId))) ?? '0');
  }

  async reserve(organizationId: string, count: number, cap: number) {
    const key = this.key(organizationId);
    const used = await this.valkey.incrby(key, count);
    if (used === count) await this.valkey.expire(key, 90_000);
    if (used > cap) {
      await this.valkey.decrby(key, count);
      return false;
    }
    return true;
  }

  async record(input: Parameters<AiImageAllowance['record']>[0]) {
    await this.ledger.record({
      orgId: input.organizationId,
      task: 'assets.ai_image',
      promptVersion: 1,
      provider: 'openai',
      model: input.model,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: input.costUsd,
      latencyMs: input.latencyMs,
      status: input.status,
      errorCode: input.status === 'error' ? 'GENERATION_FAILED' : null,
      traceId: null,
    });
  }
}
