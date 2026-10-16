import { z } from 'zod';

// The agent-runner protocol (BF-043), version 1: what the worker sends a sandbox on stdin and the frames the
// sandbox's supervisor answers on stdout. Any sandbox provider (Docker today, hosted sandboxes later) speaks it.
//
// stdin:  line 1 = RunnerInput JSON, line 2 = the bundle's byte length (decimal), then the workspace bundle
//         (tar.zst), then EOF.
// stdout: one RunnerFrame JSON per line.

export const RUNNER_PROTOCOL = 1;

/** A run's command line: argv only (no shell), the program first. */
const Argv = z.array(z.string().min(1).max(4096)).min(1).max(64);

export const RunnerInputSchema = z
  .object({
    protocol: z.literal(RUNNER_PROTOCOL),
    runId: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
    command: Argv,
    /** Applied to the child only (secrets: never written to disk, redacted from every frame). */
    env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/), z.string().max(8192)).default({}),
    /** Names in `env` whose values are secrets (redacted wherever they appear). */
    secrets: z
      .array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/))
      .max(32)
      .default([]),
    wallTimeSec: z
      .number()
      .int()
      .min(10)
      .max(4 * 3600),
    checkCommand: Argv.default(['sitekit', 'check', '--json']),
    /** Workspace globs to send back as artifacts (e.g. `site.json`, `.sitekit/screenshots/*.png`). */
    collect: z.array(z.string().min(1).max(200)).max(32).default(['site.json']),
    limits: z
      .object({
        /** Total bytes of artifacts sent back. */
        maxArtifactBytes: z
          .number()
          .int()
          .positive()
          .max(64 * 1024 * 1024)
          .default(16 * 1024 * 1024),
        /** Bytes of the workspace bundle accepted. */
        maxBundleBytes: z
          .number()
          .int()
          .positive()
          .max(64 * 1024 * 1024)
          .default(16 * 1024 * 1024),
      })
      .default({ maxArtifactBytes: 16 * 1024 * 1024, maxBundleBytes: 16 * 1024 * 1024 }),
  })
  .strict()
  .meta({ id: 'RunnerInput' });
export type RunnerInput = z.input<typeof RunnerInputSchema>;
export type ParsedRunnerInput = z.output<typeof RunnerInputSchema>;

export const RUNNER_EXIT_REASONS = [
  'completed',
  'failed',
  'timeout',
  'killed',
  'input_invalid',
  'workspace_invalid',
  'internal',
] as const;
export type RunnerExitReason = (typeof RUNNER_EXIT_REASONS)[number];

const line = z.string().max(64 * 1024);

export const RunnerFrameSchema = z
  .discriminatedUnion('t', [
    z.object({
      t: z.literal('versions'),
      protocol: z.literal(RUNNER_PROTOCOL),
      versions: z.record(z.string().max(40), z.string().max(200)),
    }),
    z.object({ t: z.literal('engine'), line }),
    z.object({ t: z.literal('stderr'), line }),
    z.object({ t: z.literal('heartbeat'), at: z.iso.datetime() }),
    z.object({
      t: z.literal('check'),
      exitCode: z.number().int(),
      /** The check command's JSON output (sitekit check --json), when it printed one. */
      report: z.unknown().nullable(),
    }),
    z.object({
      t: z.literal('artifact'),
      name: z.string().min(1).max(300),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z.number().int().nonnegative(),
      seq: z.number().int().nonnegative(),
      /** True on the artifact's last chunk. */
      last: z.boolean(),
      /** Base64, at most 256 KB of data per chunk. */
      data: z.string().max(Math.ceil((256 * 1024) / 3) * 4),
    }),
    z.object({
      t: z.literal('exit'),
      code: z.number().int(),
      reason: z.enum(RUNNER_EXIT_REASONS),
      message: z.string().max(2000).optional(),
    }),
  ])
  .meta({ id: 'RunnerFrame' });
export type RunnerFrame = z.infer<typeof RunnerFrameSchema>;

export const ARTIFACT_CHUNK_BYTES = 256 * 1024;

/** Parses one stdout line; undefined for anything that is not a valid frame (counted, never acted on). */
export function parseRunnerFrame(text: string): RunnerFrame | undefined {
  if (!text.startsWith('{')) return undefined;
  try {
    const parsed = RunnerFrameSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The stdin of a run: the input line, the bundle length line, the bundle. */
export function encodeRunnerStdin(input: RunnerInput, bundle: Uint8Array): Uint8Array[] {
  const encoder = new TextEncoder();
  return [
    encoder.encode(`${JSON.stringify(RunnerInputSchema.parse(input))}\n`),
    encoder.encode(`${bundle.byteLength}\n`),
    bundle,
  ];
}
