import type { z } from 'zod';

export const AI_TIERS = ['fast', 'smart', 'agent'] as const;
export type AiTier = (typeof AI_TIERS)[number];

interface BaseTask<I extends z.ZodType> {
  /** `<context>.<name>`, e.g. `search.parse_intent`. */
  readonly name: string;
  readonly tier: AiTier;
  /** Prompt id `<task>.v<N>` (file `prompts/<task>.v<N>.md`). */
  readonly prompt: string;
  readonly input: I;
  readonly temperature?: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Identical input (same prompt version and model) → cached result for this long. */
  readonly cacheTtlSeconds?: number;
  /** Cache entries per workspace (default) or shared, for inputs with no workspace-private data. */
  readonly cacheScope?: 'org' | 'global';
  /** Eval dataset folder under `evals/`. */
  readonly evalSet?: string;
  /** Essential tasks still run past the hard budget (e.g. reply triage); others are refused. */
  readonly essential?: boolean;
  /** Prompt variables; defaults to the parsed input. */
  readonly variables?: (input: z.output<I>) => Record<string, unknown>;
}

export interface ObjectTask<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType>
  extends BaseTask<I> {
  readonly kind: 'object';
  /** What the model must return (field descriptions are sent to the model). */
  readonly output: O;
}

export interface TextTask<I extends z.ZodType = z.ZodType> extends BaseTask<I> {
  readonly kind: 'text';
}

export interface VisionTask<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType>
  extends BaseTask<I> {
  readonly kind: 'vision';
  readonly output: O;
  /** Longest side images are resized to before sending (pixels). */
  readonly maxImageDimension?: number;
}

export type AiTask = ObjectTask | TextTask | VisionTask;

const TASK_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const registry = new Map<string, AiTask>();

/** Declares a task once (names are unique); feature code passes it to the gateway. */
export function defineTask<I extends z.ZodType, O extends z.ZodType>(
  task: ObjectTask<I, O>,
): ObjectTask<I, O>;
export function defineTask<I extends z.ZodType>(task: TextTask<I>): TextTask<I>;
export function defineTask<I extends z.ZodType, O extends z.ZodType>(
  task: VisionTask<I, O>,
): VisionTask<I, O>;
export function defineTask(task: AiTask): AiTask {
  if (!TASK_NAME.test(task.name)) throw new Error(`Task name "${task.name}" must look like "context.name"`);
  if (!task.prompt.startsWith(`${task.name}.v`)) {
    throw new Error(
      `Task ${task.name} must use one of its own prompts (${task.name}.v<N>), got ${task.prompt}`,
    );
  }
  if (registry.has(task.name)) throw new Error(`Task ${task.name} is already defined`);
  registry.set(task.name, task);
  return task;
}

export const getTask = (name: string): AiTask | undefined => registry.get(name);
export const registeredTasks = (): readonly AiTask[] => [...registry.values()];
