import type { GenerationStreamEvent } from '@bf/contracts';

// A job's activity as the console keeps it (BF-046): events in sequence order, each once — a reconnect replays from
// the last id it saw, the browser may replay the same ids again, and both must leave no gap and no duplicate.
// Pure: the hook feeds it, the list renders its rows.

export type LoggedEvent = GenerationStreamEvent & { readonly seq: number };

export const FILTERS = ['all', 'tools', 'logs', 'errors'] as const;
export type Filter = (typeof FILTERS)[number];

/** Heartbeats keep the stream open; they are not activity. */
const HIDDEN = new Set(['heartbeat']);

/** `log` appended with the incoming events it has not seen (by seq, ascending), and the new last seq. */
export function merge(
  log: readonly LoggedEvent[],
  lastSeq: number,
  incoming: readonly LoggedEvent[],
): { log: LoggedEvent[]; lastSeq: number } {
  const fresh = incoming.filter((event) => event.seq > lastSeq).sort((a, b) => a.seq - b.seq);
  const next = [...log];
  let last = lastSeq;
  for (const event of fresh) {
    if (event.seq <= last) continue;
    next.push(event);
    last = event.seq;
  }
  return { log: next, lastSeq: last };
}

export function matches(event: LoggedEvent, filter: Filter, search: string): boolean {
  if (HIDDEN.has(event.type)) return false;
  const kind =
    filter === 'all' ||
    (filter === 'tools' && (event.type === 'tool_call' || event.type === 'file_change')) ||
    (filter === 'logs' && (event.type === 'log' || event.type === 'status' || event.type === 'progress')) ||
    (filter === 'errors' && (event.type === 'error' || (event.type === 'log' && event.level !== 'info')));
  if (!kind) return false;
  const query = search.trim().toLowerCase();
  return query === '' || textOf(event).toLowerCase().includes(query);
}

/** What search looks into. */
export function textOf(event: LoggedEvent): string {
  switch (event.type) {
    case 'log':
      return event.message;
    case 'tool_call':
      return `${event.tool} ${event.summary}`;
    case 'file_change':
      return event.path;
    case 'error':
      return `${event.code} ${event.message}`;
    case 'progress':
      return event.label;
    case 'status':
      return event.phase;
    case 'artifact':
      return event.kind;
    default:
      return event.type;
  }
}

export type Row =
  | { readonly kind: 'attempt'; readonly key: string; readonly attempt: number | null }
  | { readonly kind: 'event'; readonly key: string; readonly event: LoggedEvent };

/** The list's rows: an attempt header wherever the attempt changes, then its matching events. */
export function rowsOf(log: readonly LoggedEvent[], filter: Filter, search: string): Row[] {
  const rows: Row[] = [];
  let current: number | null | undefined;
  for (const event of log) {
    if (!matches(event, filter, search)) continue;
    if (event.attempt !== current) {
      current = event.attempt;
      rows.push({ kind: 'attempt', key: `attempt-${event.seq}`, attempt: event.attempt });
    }
    rows.push({ kind: 'event', key: String(event.seq), event });
  }
  return rows;
}

/** Cost and tokens so far (the usage events of every attempt). */
export function usageOf(log: readonly LoggedEvent[]): { costUsd: number; tokens: number } {
  let costUsd = 0;
  let tokens = 0;
  for (const event of log)
    if (event.type === 'usage') {
      costUsd += event.costUsd;
      tokens += event.inputTokens + event.outputTokens;
    }
  return { costUsd: Math.round(costUsd * 10_000) / 10_000, tokens };
}
