/** One structured log line (JSON on stdout/stderr): the renderer has no request data worth more, and no secret. */
export function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: 'bf-sites', msg, ...fields });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/** An error as log fields (its message and name, never the SQL parameters of a driver error). */
export const errorFields = (error: unknown) =>
  error instanceof Error ? { err: { name: error.name, message: error.message } } : { err: String(error) };
