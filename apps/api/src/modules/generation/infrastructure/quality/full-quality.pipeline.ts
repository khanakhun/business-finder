import { createHash } from 'node:crypto';
import type { QualityAutoFix, QualityGateResult, QualityIssue, QualityReport } from '@bf/contracts';
import type { FactRegistry } from '@bf/site-schema';
import { type AuditReport, parseFacts, type SitekitConfig, SitekitConfigSchema } from '@bf/sitekit';
import type {
  ArtifactStore,
  GenerationRepository,
  QualityPipeline,
  QualityResult,
} from '../../application/ports.ts';
import { decide } from '../../domain/quality/decision-policy.ts';
import { qualityScore } from '../../domain/quality/scorer.ts';
import { PLATFORM_MINIMUMS, type QualityThresholds } from '../../domain/quality/thresholds.ts';
import { unpackBundle } from '../workspace/tar.ts';
import { a11yGate, performanceGate } from './audit-gates.ts';
import { autoFix, copyGate, factsGate, type GateContext, type QualityGate, schemaGate } from './gates.ts';
import type { SandboxAuditClient } from './sandbox-audit.client.ts';

// The quality pipeline (BF-045) as BF-039's port: the gates in order — schema and facts short-circuit on an error —
// then the safe auto-fixes and one more pass on the fixed candidate, the score and the decision. A gate that throws
// is tried once more, then marked `error`: the version goes to a person, never through. The job's registry is the one
// in the attempt's workspace bundle (BF-040), the snapshot the engine wrote against. Results are cached per candidate.

export const PIPELINE_VERSION = 1;
/** Gates whose errors stop the chain: what comes after assumes a valid, factual site. */
const SHORT_CIRCUIT = new Set(['schema', 'facts']);
/** Gates that render the site (the sandboxed audit): they run once, after the fixes. */
const RENDERED = new Set(['a11y', 'performance', 'visual']);
const CACHE_SIZE = 200;

export interface FullQualityPipelineDeps {
  readonly artifacts: Pick<ArtifactStore, 'get'>;
  readonly repository: Pick<GenerationRepository, 'artifactKey'>;
  readonly assetHosts: readonly string[];
  readonly hotlinkHosts?: readonly string[];
  readonly thresholds?: QualityThresholds;
  readonly gates?: readonly QualityGate[];
  /** The sandboxed audits (axe, Lighthouse): with it, the accessibility and performance gates run. */
  readonly audits?: Pick<SandboxAuditClient, 'audit'>;
  readonly now?: () => Date;
}

interface Registry {
  readonly facts: FactRegistry;
  readonly config: SitekitConfig;
  /** The workspace's files: the audit renders the candidate in them. */
  readonly files: ReadonlyMap<string, Buffer>;
}

/** A report's issue as engines read it (BF-041/BF-044 repair): `at` next to the target. */
const forEngines = (issue: QualityIssue) => ({
  ...issue,
  ...(issue.target?.path ? { at: issue.target.path } : {}),
});

export class FullQualityPipeline implements QualityPipeline {
  private readonly cache = new Map<
    string,
    { gates: QualityGateResult[]; autoFixes: QualityAutoFix[]; spec: unknown }
  >();

  constructor(private readonly deps: FullQualityPipelineDeps) {}

  private get gates(): readonly QualityGate[] {
    return (
      this.deps.gates ?? [
        schemaGate,
        factsGate,
        copyGate,
        ...(this.deps.audits ? [a11yGate, performanceGate] : []),
      ]
    );
  }

  /** The job's registry snapshot from the attempt's workspace bundle (undefined when it cannot be read). */
  private async registry(jobId: string, attemptId: string | undefined): Promise<Registry | undefined> {
    if (!attemptId) return undefined;
    const key = await this.deps.repository.artifactKey(jobId, attemptId, 'workspace_bundle');
    const bundle = key ? await this.deps.artifacts.get(key) : undefined;
    if (!bundle) return undefined;
    try {
      const files = unpackBundle(bundle);
      const json = (name: string) => JSON.parse(files.get(name)?.toString('utf8') ?? 'null') as unknown;
      return {
        facts: parseFacts(json('facts.json')),
        config: SitekitConfigSchema.parse(files.has('.sitekit.json') ? json('.sitekit.json') : {}),
        files,
      };
    } catch {
      return undefined;
    }
  }

  private async runGate(gate: QualityGate, ctx: GateContext): Promise<QualityGateResult> {
    const started = performance.now();
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await gate.run(ctx);
        return { id: gate.id, durationMs: Math.round(performance.now() - started), ...result };
      } catch (error) {
        lastError = error;
      }
    }
    return {
      id: gate.id,
      status: 'error',
      durationMs: Math.round(performance.now() - started),
      costUsd: 0,
      issues: [
        {
          gate: gate.id,
          code: 'gate_error',
          severity: 'error',
          message:
            `The ${gate.id} gate could not run: ${lastError instanceof Error ? lastError.message : String(lastError)}`.slice(
              0,
              600,
            ),
          repairable: false,
          autoFixable: false,
        },
      ],
    };
  }

  /** The gates in order on one candidate; schema and facts errors skip the rest. */
  private async chain(
    ctx: GateContext,
    gates: readonly QualityGate[],
    stopped = false,
  ): Promise<QualityGateResult[]> {
    const results: QualityGateResult[] = [];
    for (const gate of gates) {
      if (stopped) {
        results.push({ id: gate.id, status: 'skipped', durationMs: 0, costUsd: 0, issues: [] });
        continue;
      }
      const result = await this.runGate(gate, ctx);
      results.push(result);
      if (result.status === 'error' || (result.status === 'fail' && SHORT_CIRCUIT.has(gate.id)))
        stopped = true;
    }
    return results;
  }

  async evaluate(input: Parameters<QualityPipeline['evaluate']>[0]): Promise<QualityResult> {
    const thresholds = this.deps.thresholds ?? PLATFORM_MINIMUMS;
    const registry = await this.registry(input.job.id, input.attemptId);
    const inputHash = createHash('sha256').update(JSON.stringify(input.spec)).digest('hex');
    const cacheKey = `${PIPELINE_VERSION}:${input.attemptId ?? '-'}:${inputHash}`;
    let run = this.cache.get(cacheKey);
    if (!run) {
      const base = {
        facts: registry?.facts ?? { facts: [] },
        config: registry?.config ?? SitekitConfigSchema.parse({}),
        assetHosts: this.deps.assetHosts,
        hotlinkHosts: this.deps.hotlinkHosts ?? [],
        thresholds,
      } satisfies Omit<GateContext, 'spec'>;
      // The deterministic gates first (and again after the fixes), then the rendered ones once, on the final
      // candidate: one audit run serves accessibility and performance.
      const deterministic = this.gates.filter((gate) => !RENDERED.has(gate.id));
      const rendered = this.gates.filter((gate) => RENDERED.has(gate.id));
      let spec = input.spec;
      let gates = await this.chain({ ...base, spec }, deterministic);
      let autoFixes: QualityAutoFix[] = [];
      const fixable = gates.some(
        (gate) => gate.status !== 'skipped' && gate.issues.some((issue) => issue.autoFixable),
      );
      if (fixable) {
        const fixed = autoFix(spec, base);
        if (fixed.fixes.length > 0) {
          autoFixes = fixed.fixes;
          spec = fixed.spec;
          gates = await this.chain({ ...base, spec }, deterministic);
        }
        gates.push({
          id: 'autofix',
          status: 'pass',
          durationMs: 0,
          costUsd: 0,
          issues: autoFixes.map((fix) => ({
            gate: 'autofix' as const,
            code: fix.rule,
            severity: 'info' as const,
            message: `Fixed ${fix.rule} at ${fix.path}.`,
            target: { path: fix.path },
            repairable: false,
            autoFixable: true,
          })),
        });
      }
      if (rendered.length > 0) {
        let audit: Promise<AuditReport> | undefined;
        const candidate = spec;
        const auditOnce = () => {
          if (!this.deps.audits) throw new Error('No audit sandbox is configured.');
          if (!registry) throw new Error("The job's workspace could not be read: nothing to render.");
          // Memoized for this candidate; a failure is forgotten, so the gate's retry runs the audit again.
          audit ??= this.deps.audits
            .audit(registry.files, candidate, {
              jobId: input.job.id,
              organizationId: input.job.organizationId,
            })
            .catch((error: unknown) => {
              audit = undefined;
              throw error;
            });
          return audit;
        };
        const stopped = gates.some(
          (gate) => gate.status === 'error' || (gate.status === 'fail' && SHORT_CIRCUIT.has(gate.id)),
        );
        gates.push(
          ...(await this.chain(
            { ...base, spec: candidate, audit: auditOnce } as GateContext,
            rendered,
            stopped,
          )),
        );
      }
      if (!registry) {
        // Without the job's registry no fact can be checked: a person looks (never a silent pass).
        const facts = gates.find((gate) => gate.id === 'facts');
        if (facts && facts.status !== 'skipped')
          Object.assign(facts, {
            status: 'error',
            issues: [
              {
                gate: 'facts',
                code: 'registry_missing',
                severity: 'error',
                message: "The job's fact registry (its workspace bundle) could not be read.",
                repairable: false,
                autoFixable: false,
              },
            ],
          } satisfies Partial<QualityGateResult>);
      }
      run = { gates, autoFixes, spec };
      this.cache.set(cacheKey, run);
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
    }
    const decision = decide({
      gates: run.gates,
      repairsLeft: input.repairsLeft,
      supportsRepair: input.supportsRepair,
    });
    const score = qualityScore(run.gates);
    const report: QualityReport = {
      pipelineVersion: PIPELINE_VERSION,
      candidateHash: createHash('sha256').update(JSON.stringify(run.spec)).digest('hex'),
      score,
      decision: decision.decision,
      infraError: decision.infraError,
      gates: run.gates,
      autoFixes: run.autoFixes,
      issues: decision.issues,
      screenshots: [],
      createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
    };
    return {
      outcome: decision.decision,
      score,
      issues: decision.issues.map(forEngines),
      ...(run.autoFixes.length > 0 ? { spec: run.spec } : {}),
      report,
    };
  }
}
