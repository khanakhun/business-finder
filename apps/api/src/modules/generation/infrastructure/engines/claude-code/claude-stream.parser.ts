import { costUsd, type ModelPricing } from '@bf/ai';
import type { EngineEvent } from '@bf/contracts';
import type { AgentFailure, AgentStreamParser } from '../sandboxed/sandboxed-agent.engine.ts';

// Claude Code's `--output-format stream-json` (CLI 2.1.x; the Agent SDK prints the same `SDKMessage`s, BF-044) as
// engine events (Adapter). Lines: `system` (init, permission_denied…), `assistant` (text and tool_use blocks, with
// the message's usage), `user` (tool results), `result` (cost, usage, subtype, structured output). Anything else is
// skipped: a new message type must never crash a run.

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Tools whose successful result means site.json may have changed. */
const WRITES = new Set(['Edit', 'Write', 'MultiEdit']);
const SITEKIT_WRITES = /^sitekit\s+(ops\b|lint-copy\s.*--fix)/;

function summarize(name: string, input: Json | undefined): string {
  const path = str(input?.file_path) ?? str(input?.path);
  if (name === 'Bash') return short(str(input?.command) ?? '', 300);
  if (path) return short(path.replace(/^\/workspace\//, ''), 300);
  if (name.startsWith('mcp__')) return short(JSON.stringify(input ?? {}), 300);
  return short(str(input?.pattern) ?? str(input?.description) ?? '', 300);
}

interface MessageUsage {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

export class ClaudeStreamParser implements AgentStreamParser {
  private model: string | undefined;
  /** Usage per assistant message id (a message's blocks may arrive on several lines with the same usage). */
  private readonly usage = new Map<string, MessageUsage>();
  private readonly pending = new Map<string, { name: string; input: Json | undefined }>();
  private result: Json | undefined;

  constructor(private readonly pricing: ModelPricing) {}

  line(text: string): EngineEvent[] {
    let message: Json | undefined;
    try {
      message = obj(JSON.parse(text));
    } catch {
      return [];
    }
    switch (message?.type) {
      case 'system':
        return this.system(message);
      case 'assistant':
        return this.assistant(message);
      case 'user':
        return this.user(message);
      case 'result':
        this.result = message;
        return [];
      default:
        return [];
    }
  }

  private system(message: Json): EngineEvent[] {
    if (message.subtype === 'init') {
      this.model = str(message.model) ?? this.model;
      const tools = Array.isArray(message.tools) ? message.tools.filter((t) => typeof t === 'string') : [];
      return [
        {
          type: 'log',
          level: 'info',
          message: short(
            `Agent started: ${this.model ?? 'model?'}; tools ${tools.join(', ') || 'none'}.`,
            2000,
          ),
        },
      ];
    }
    if (message.subtype === 'permission_denied')
      return [
        {
          type: 'log',
          level: 'warn',
          message: short(`Denied ${str(message.tool_name) ?? 'a tool'}: ${str(message.message) ?? ''}`, 2000),
        },
      ];
    return [];
  }

  private assistant(message: Json): EngineEvent[] {
    const body = obj(message.message);
    const id = str(body?.id);
    const usage = obj(body?.usage);
    if (id && usage) {
      const cached = num(usage.cache_read_input_tokens);
      this.usage.set(id, {
        input: num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + cached,
        cached,
        output: num(usage.output_tokens),
      });
    }
    this.model = str(body?.model) ?? this.model;
    const events: EngineEvent[] = [];
    for (const block of Array.isArray(body?.content) ? body.content : []) {
      const content = obj(block);
      if (content?.type === 'tool_use') {
        const name = str(content.name) ?? 'tool';
        const input = obj(content.input);
        const toolId = str(content.id);
        if (toolId) this.pending.set(toolId, { name, input });
        events.push({ type: 'tool_call', tool: short(name, 100), summary: summarize(name, input) });
      } else if (content?.type === 'text' && str(content.text)?.trim())
        events.push({ type: 'log', level: 'info', message: short((content.text as string).trim(), 500) });
    }
    return events;
  }

  private user(message: Json): EngineEvent[] {
    const events: EngineEvent[] = [];
    const content = obj(message.message)?.content;
    for (const block of Array.isArray(content) ? content : []) {
      const result = obj(block);
      if (result?.type !== 'tool_result') continue;
      const call = this.pending.get(str(result.tool_use_id) ?? '');
      if (!call || result.is_error === true) continue;
      this.pending.delete(str(result.tool_use_id) ?? '');
      const path = str(call.input?.file_path) ?? '';
      const writesSite =
        (WRITES.has(call.name) && /(^|\/)site\.json$/.test(path)) ||
        (call.name === 'Bash' && SITEKIT_WRITES.test(str(call.input?.command) ?? '')) ||
        /^mcp__sitekit__(ops|apply|lint_copy_fix)/.test(call.name);
      if (writesSite) events.push({ type: 'file_change', path: 'site.json' });
    }
    return events;
  }

  tokens() {
    if (this.result) {
      const usage = obj(this.result.usage);
      if (usage)
        return {
          input:
            num(usage.input_tokens) +
            num(usage.cache_creation_input_tokens) +
            num(usage.cache_read_input_tokens),
          output: num(usage.output_tokens),
        };
    }
    let input = 0;
    let output = 0;
    for (const usage of this.usage.values()) {
      input += usage.input;
      output += usage.output;
    }
    return { input, output };
  }

  costUsd(): number | null {
    if (this.result && typeof this.result.total_cost_usd === 'number') return this.result.total_cost_usd;
    if (!this.model) return null;
    let total = 0;
    for (const usage of this.usage.values()) {
      const cost = costUsd(this.pricing, this.model, {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cachedTokens: usage.cached,
      });
      if (cost === null) return null;
      total += cost;
    }
    return total;
  }

  outcome(): { report?: unknown; failure?: AgentFailure } {
    const result = this.result;
    if (!result)
      return {
        failure: { code: 'ENGINE_INCOMPLETE', message: 'The agent ended without a result.', retryable: true },
      };
    const errors = Array.isArray(result.errors)
      ? result.errors.filter((e) => typeof e === 'string').join('; ')
      : '';
    const detail = short(errors || str(result.result) || '', 500);
    switch (result.subtype) {
      case 'success':
        // An API failure is reported as a "success" with is_error (CLI 2.1.x).
        if (result.is_error === true)
          return {
            failure: { code: 'PROVIDER_ERROR', message: `The model API failed: ${detail}`, retryable: true },
          };
        return { report: result.structured_output };
      case 'error_max_budget_usd':
        return {
          failure: {
            code: 'ENGINE_BUDGET_EXCEEDED',
            message: 'The agent reached its budget.',
            retryable: false,
          },
        };
      case 'error_max_turns':
        return {
          failure: {
            code: 'ENGINE_INCOMPLETE',
            message: `The agent used all its turns (${num(result.num_turns)}).`,
            retryable: true,
          },
        };
      case 'error_max_structured_output_retries':
        return {
          failure: {
            code: 'ENGINE_INVALID_OUTPUT',
            message: 'The agent could not write its final report.',
            retryable: true,
          },
        };
      default:
        return {
          failure: {
            code: 'ENGINE_INCOMPLETE',
            message: `The agent stopped (${str(result.subtype) ?? 'unknown'}): ${detail}`,
            retryable: true,
          },
        };
    }
  }
}
