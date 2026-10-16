/** One structured log line (JSON): the renderer has no request data worth more, and no secret. */
export function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: 'bf-sites', msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/**
 * An error as log fields: its name and the underlying cause (connection refused, timeout…). A driver's "Failed
 * query: … params: …" message is left out: it repeats the query and its parameters.
 */
export function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { err: { message: String(error) } };
  const cause =
    error.cause instanceof Error ? { name: error.cause.name, message: error.cause.message } : undefined;
  const message = error.message.startsWith('Failed query') ? undefined : error.message;
  return { err: { name: error.name, ...(message ? { message } : {}), ...(cause ? { cause } : {}) } };
}
