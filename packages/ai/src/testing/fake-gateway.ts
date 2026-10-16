import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { ZERO_USAGE } from '../cost.ts';
import type { AiContext, AiGateway, AiResult } from '../gateway.ts';
import { loadPromptRegistry, type PromptRegistry } from '../prompts/registry.ts';
import type { AiImage } from '../vision.ts';
import { fakeEmbedding } from './fake-embeddings.ts';
import { fixturePath, readFixture, writeFixture } from './fixtures.ts';

export class MissingFixtureError extends Error {
  constructor(task: string, path: string) {
    super(
      `No recorded answer for ${task} at ${path}.\n` +
        'Record it with real keys: AI_FIXTURES=record (see packages/ai/README.md, "Recording fixtures"), ' +
        'or add the file by hand with a realistic output.',
    );
    this.name = 'MissingFixtureError';
  }
}

export interface FakeAiGatewayOptions {
  readonly fixturesDir: string;
  /** `replay` (default): recorded answers only. `record`: call `gateway` and save its answers. */
  readonly mode?: 'replay' | 'record';
  readonly gateway?: AiGateway;
  readonly prompts?: PromptRegistry;
  readonly embeddingDims?: number;
}

export interface FakeAiGateway extends AiGateway {
  /** Every call, for assertions. */
  readonly calls: Array<{ readonly task: string; readonly input: unknown; readonly orgId: string | null }>;
}

const digestImage = (image: AiImage) =>
  'url' in image ? image.url : createHash('sha256').update(image.bytes).digest('hex');

/** Record/replay gateway for tests and CI evals: never touches the network in replay mode. */
export function createFakeAiGateway(options: FakeAiGatewayOptions): FakeAiGateway {
  const prompts = options.prompts ?? loadPromptRegistry();
  const mode = options.mode ?? 'replay';
  if (mode === 'record' && !options.gateway) throw new Error('Recording needs a real gateway');
  const calls: FakeAiGateway['calls'] = [];

  async function answer<T>(
    task: { name: string; prompt: string; input: z.ZodType; kind: string; output?: z.ZodType },
    input: unknown,
    ctx: AiContext,
    live: () => Promise<AiResult<T>>,
  ): Promise<AiResult<T>> {
    calls.push({ task: task.name, input, orgId: ctx.orgId });
    const promptVersion = prompts.get(task.prompt).version;
    const path = fixturePath(options.fixturesDir, task.name, promptVersion, input);
    if (mode === 'record') {
      const result = await live();
      writeFixture(path, { task: task.name, promptVersion, input, output: result.output });
      return result;
    }
    const fixture = readFixture(path);
    if (!fixture) throw new MissingFixtureError(task.name, path);
    const output = (task.output ? task.output.parse(fixture.output) : String(fixture.output)) as T;
    return {
      output,
      provider: 'anthropic',
      model: 'fixture',
      promptVersion,
      usage: ZERO_USAGE,
      costUsd: 0,
      cached: false,
      latencyMs: 0,
    };
  }

  return {
    calls,
    run: (task, input, ctx) =>
      answer(task, task.input.parse(input), ctx, () => (options.gateway as AiGateway).run(task, input, ctx)),
    vision: (task, request, ctx) =>
      answer(
        task,
        { input: task.input.parse(request.input), images: request.images.map(digestImage) },
        ctx,
        () => (options.gateway as AiGateway).vision(task, request, ctx),
      ),
    async stream(task, input, ctx) {
      const result = answer<string>(task, task.input.parse(input), ctx, async () => {
        const stream = await (options.gateway as AiGateway).stream(task, input, ctx);
        return stream.result;
      });
      async function* chunks() {
        const text = (await result).output;
        for (let i = 0; i < text.length; i += 16) yield text.slice(i, i + 16);
      }
      return { textStream: chunks(), result };
    },
    async embed(texts, embedOptions) {
      calls.push({ task: `embed.${embedOptions.purpose}`, input: texts, orgId: embedOptions.orgId });
      const dims = options.embeddingDims ?? 1536;
      return { vectors: texts.map((text) => fakeEmbedding(text, dims)), model: 'fake-embedding', dims };
    },
  };
}
