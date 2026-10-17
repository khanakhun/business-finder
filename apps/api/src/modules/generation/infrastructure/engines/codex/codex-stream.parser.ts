import { costUsd, type ModelPricing } from '@bf/ai';
import type { EngineEvent } from '@bf/contracts';
import type { AgentFailure, AgentStreamParser } from '../sandboxed/sandboxed-agent.engine.ts';

// Codex's `exec --json` events (0.160.0, `codex-rs/exec/src/exec_events.rs`) as engine events (Adapter):
// `thread.started`, `turn.started`, `turn.completed{usage}`, `turn.failed{error}`, `item.started|updated|completed`
// with items (agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, todo_list,
// error), and top-level `error` — emitted for recoverable reconnects too, so it is logged, never fatal. Usage comes
// only at the end of the turn, as cumulative totals; Codex reports no USD, so the cost is its tokens priced
// (`AI_PRICING`). Unknown events and items are skipped.

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export class CodexStreamParser implements AgentStreamParser {
  private usage: { input: number; cached: number; output: number } | undefined;
  private lastMessage: string | undefined;
  private completed = false;
  private failed: string | undefined;
  /** Item ids already reported as tool calls (an item can start, update and complete). */
  private readonly called = new Set<string>();

  constructor(
    private readonly pricing: ModelPricing,
    private readonly model: string,
  ) {}

  line(text: string): EngineEvent[] {
    let event: Json | undefined;
    try {
      event = obj(JSON.parse(text));
    } catch {
      return [];
    }
    switch (event?.type) {
      case 'thread.started':
        return [{ type: 'log', level: 'info', message: `Agent started: ${this.model}.` }];
      case 'turn.completed': {
        const usage = obj(event.usage);
        this.completed = true;
        this.usage = {
          input: num(usage?.input_tokens),
          cached: num(usage?.cached_input_tokens),
          output: num(usage?.output_tokens),
        };
        return [];
      }
      case 'turn.failed':
        this.failed = str(obj(event.error)?.message) ?? 'unknown';
        return [{ type: 'log', level: 'error', message: short(`The turn failed: ${this.failed}`, 2000) }];
      case 'error':
        return [{ type: 'log', level: 'warn', message: short(str(event.message) ?? 'error', 2000) }];
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.item(obj(event.item), event.type === 'item.completed');
      default:
        return [];
    }
  }

  private item(item: Json | undefined, completed: boolean): EngineEvent[] {
    if (!item) return [];
    const id = str(item.id) ?? '';
    const call = (tool: string, summary: string): EngineEvent[] => {
      if (this.called.has(id)) return [];
      this.called.add(id);
      return [{ type: 'tool_call', tool: short(tool, 100), summary: short(summary, 300) }];
    };
    switch (item.type) {
      case 'command_execution': {
        const events = call('shell', str(item.command) ?? '');
        if (completed && (item.status === 'failed' || item.status === 'declined'))
          events.push({
            type: 'log',
            level: 'warn',
            message: short(
              `Command ${item.status} (exit ${String(item.exit_code ?? '?')}): ${str(item.command) ?? ''}`,
              2000,
            ),
          });
        return events;
      }
      case 'mcp_tool_call':
        return call(
          `mcp__${str(item.server) ?? 'mcp'}__${str(item.tool) ?? 'tool'}`,
          JSON.stringify(item.arguments ?? {}),
        );
      case 'file_change': {
        if (!completed || item.status === 'failed') return [];
        const changes = Array.isArray(item.changes) ? item.changes.map(obj) : [];
        return changes.some((change) => /(^|\/)site\.json$/.test(str(change?.path) ?? ''))
          ? [{ type: 'file_change', path: 'site.json' }]
          : [];
      }
      case 'agent_message':
        if (!completed) return [];
        this.lastMessage = str(item.text);
        return this.lastMessage?.trim()
          ? [{ type: 'log', level: 'info', message: short(this.lastMessage.trim(), 500) }]
          : [];
      case 'error':
        return completed
          ? [{ type: 'log', level: 'warn', message: short(str(item.message) ?? 'error', 2000) }]
          : [];
      case 'web_search':
        // Disabled by config; reported if it ever happens.
        return call('web_search', str(item.query) ?? '');
      default:
        return [];
    }
  }

  tokens() {
    return { input: this.usage?.input ?? 0, output: this.usage?.output ?? 0 };
  }

  costUsd(): number | null {
    if (!this.usage) return this.pricing[this.model] ? 0 : null;
    return costUsd(this.pricing, this.model, {
      inputTokens: this.usage.input,
      outputTokens: this.usage.output,
      cachedTokens: this.usage.cached,
    });
  }

  outcome(): { report?: unknown; failure?: AgentFailure } {
    if (this.failed)
      return {
        failure: {
          code: 'ENGINE_INCOMPLETE',
          message: short(`The agent's turn failed: ${this.failed}`, 1000),
          retryable: true,
        },
      };
    if (!this.completed)
      return {
        failure: {
          code: 'ENGINE_INCOMPLETE',
          message: 'The agent ended without completing its turn.',
          retryable: true,
        },
      };
    try {
      return { report: JSON.parse(this.lastMessage ?? '') as unknown };
    } catch {
      return { report: undefined };
    }
  }
}
