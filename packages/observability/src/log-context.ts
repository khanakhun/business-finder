import { AsyncLocalStorage } from 'node:async_hooks';

/** Fields attached to every log line emitted inside `withLogContext` (ADR-0015). */
export interface LogContext {
  readonly requestId?: string;
  readonly orgId?: string;
  readonly userId?: string;
  readonly jobId?: string;
  readonly queue?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with `fields` merged over the current log context (inner values win). */
export function withLogContext<T>(fields: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...fields }, fn);
}

export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}
