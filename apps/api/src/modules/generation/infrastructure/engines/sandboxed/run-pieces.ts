import { createHash } from 'node:crypto';
import type { RunnerFrame } from '@bf/contracts/runner';
import { type FactRegistry, parseSite, type SiteSpec } from '@bf/site-schema';
import { lintCopy, type SitekitConfig, validate } from '@bf/sitekit';

// The pieces of a sandboxed run (BF-044) the base engine composes: the artifacts reassembled from their chunks, the
// version gate on the supervisor's `versions` frame, and the validation of the result outside the sandbox.

type ArtifactFrame = Extract<RunnerFrame, { t: 'artifact' }>;

/** Reassembles chunked artifacts in order; a gap, a size or a hash mismatch drops the artifact. Bounded in bytes. */
export class ArtifactCollector {
  private readonly parts = new Map<string, { chunks: Buffer[]; next: number; bytes: number }>();
  private readonly done = new Map<string, Buffer>();
  private total = 0;

  constructor(private readonly maxBytes: number) {}

  add(frame: ArtifactFrame): void {
    const part = this.parts.get(frame.name) ?? { chunks: [], next: 0, bytes: 0 };
    if (frame.seq !== part.next) {
      this.parts.delete(frame.name);
      return;
    }
    const data = Buffer.from(frame.data, 'base64');
    part.chunks.push(data);
    part.next++;
    part.bytes += data.length;
    this.total += data.length;
    if (this.total > this.maxBytes) {
      this.parts.delete(frame.name);
      return;
    }
    this.parts.set(frame.name, part);
    if (!frame.last) return;
    this.parts.delete(frame.name);
    const body = Buffer.concat(part.chunks);
    if (body.length !== frame.bytes || createHash('sha256').update(body).digest('hex') !== frame.sha256)
      return;
    this.done.set(frame.name, body);
  }

  get(name: string): Buffer | undefined {
    return this.done.get(name);
  }

  names(): string[] {
    return [...this.done.keys()].sort();
  }
}

/** `2.1.288 (Claude Code)`, `codex-cli 0.160.0` → `[2, 1, 288]`; undefined when no version is found. */
export function parseVersion(text: string | undefined): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

const compare = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

/** A supported range: at least `min`, below `below` (e.g. `{ min: '2.1.288', below: '2.2.0' }`). */
export interface VersionRange {
  readonly min: string;
  readonly below: string;
}

export function versionSupported(reported: string | undefined, range: VersionRange): boolean {
  const version = parseVersion(reported);
  const min = parseVersion(range.min);
  const below = parseVersion(range.below);
  if (!version || !min || !below) return false;
  return compare(version, min) >= 0 && compare(version, below) < 0;
}

export const MAX_SPEC_BYTES = 1_000_000;

export type Validation =
  | { readonly ok: true; readonly spec: SiteSpec }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly issues: readonly { at: string; message: string }[];
    };

/**
 * The result checked outside the sandbox: `site.json` parsed (≤ 1 MB), sitekit's validator with strict facts against
 * the job's own registry (the bundle the worker built — never the agent's copy of `facts.json`), and copy lint errors.
 */
export function validateOutput(
  body: Buffer | undefined,
  registry: { readonly facts: FactRegistry; readonly config: SitekitConfig },
): Validation {
  if (!body) return { ok: false, reason: 'The sandbox sent no site.json back.', issues: [] };
  if (body.length > MAX_SPEC_BYTES)
    return { ok: false, reason: `site.json is ${body.length} bytes (limit ${MAX_SPEC_BYTES}).`, issues: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false, reason: 'site.json is not valid JSON.', issues: [] };
  }
  const issues = validate(raw, { config: registry.config, facts: registry.facts, strictFacts: true })
    .filter((issue) => issue.severity === 'error')
    .map((issue) => ({ at: issue.at, message: issue.message }));
  const parsed = parseSite(raw);
  if (issues.length > 0 || !parsed.spec)
    return { ok: false, reason: `${issues.length || 1} validation error(s).`, issues: issues.slice(0, 20) };
  const lint = lintCopy(parsed.spec, { config: registry.config, facts: registry.facts })
    .filter((issue) => issue.severity === 'error')
    .map((issue) => ({ at: issue.at, message: issue.message }));
  if (lint.length > 0)
    return { ok: false, reason: `${lint.length} copy error(s).`, issues: lint.slice(0, 20) };
  return { ok: true, spec: parsed.spec };
}
