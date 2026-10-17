import type { Readable } from 'node:stream';
import { type ParsedRunnerInput, RunnerInputSchema } from '@bf/contracts/runner';

// The supervisor's stdin (BF-043): the RunnerInput line, the bundle length line, the bundle, EOF — read with hard
// bounds (an input line of at most 1 MB, a bundle of at most its declared and allowed size).

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

const MAX_LINE = 1024 * 1024;

export async function readRunnerStdin(
  stream: Readable,
): Promise<{ readonly input: ParsedRunnerInput; readonly bundle: Buffer }> {
  let buffered = Buffer.alloc(0);
  let input: ParsedRunnerInput | undefined;
  let length: number | undefined;
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let data = Buffer.concat([buffered, Buffer.from(chunk)]);
    buffered = Buffer.alloc(0);
    while (input === undefined || length === undefined) {
      const newline = data.indexOf(10);
      if (newline === -1) {
        if (data.length > MAX_LINE) throw new InputError('The input line is longer than 1 MB.');
        buffered = data;
        data = Buffer.alloc(0);
        break;
      }
      const line = data.subarray(0, newline).toString('utf8');
      data = data.subarray(newline + 1);
      if (input === undefined) {
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          throw new InputError('Line 1 is not JSON (RunnerInput expected).');
        }
        const parsed = RunnerInputSchema.safeParse(json);
        if (!parsed.success) {
          const first = parsed.error.issues[0];
          throw new InputError(
            `Invalid RunnerInput${first?.path.length ? ` at ${first.path.join('.')}` : ''}: ${first?.message}.`,
          );
        }
        input = parsed.data;
      } else {
        if (!/^\d{1,12}$/.test(line)) throw new InputError('Line 2 must be the bundle length in bytes.');
        length = Number(line);
        if (length > input.limits.maxBundleBytes)
          throw new InputError(`The bundle (${length} bytes) is larger than ${input.limits.maxBundleBytes}.`);
      }
    }
    if (length !== undefined && data.length > 0) {
      received += data.length;
      if (received > length) throw new InputError('More bytes than the declared bundle length.');
      chunks.push(data);
    }
  }
  if (input === undefined || length === undefined) throw new InputError('The input ended before the bundle.');
  if (received !== length) throw new InputError(`The bundle is ${received} bytes; ${length} were declared.`);
  return { input, bundle: Buffer.concat(chunks) };
}
