import { createHash } from 'node:crypto';
import type { EngineId, GenerationSettings } from '@bf/contracts';
import { type Issue, validateSite } from '@bf/site-schema';
import type {
  AgentEngine,
  EngineRegistry,
  GenerationSettingsReader,
  QualityPipeline,
  StoredJob,
  WorkspacePreparer,
  WorkspaceSummary,
} from '../../application/ports.ts';

// Default implementations the later tickets replace (BF-039): the engine registry, a fixture workspace preparer
// (BF-040 builds the real brief, facts and assets), a schema-only quality pipeline (BF-045 adds the gates) and the
// workspace's default generation settings (a settings screen comes with BF-046).

export class StaticEngineRegistry implements EngineRegistry {
  private readonly byId: Map<EngineId, AgentEngine>;
  constructor(engines: readonly AgentEngine[]) {
    this.byId = new Map(engines.map((engine) => [engine.id, engine]));
  }
  list() {
    return [...this.byId.values()];
  }
  get(id: EngineId) {
    return this.byId.get(id);
  }
}

/** A workspace from the site fixtures and the business's name: the flow runs without BF-040. */
export class FixtureWorkspacePreparer implements WorkspacePreparer {
  constructor(private readonly writeBundle: (key: string, body: Buffer) => Promise<void>) {}

  async estimate(
    _job: Pick<StoredJob, 'organizationId' | 'businessId'>,
    locales: readonly string[],
  ): Promise<WorkspaceSummary> {
    return { businessName: '', pages: 3, items: 8, locales };
  }

  async prepare(job: StoredJob) {
    const summary: WorkspaceSummary = {
      businessName: job.businessName,
      pages: 3,
      items: 8,
      locales: ['fr', 'en'],
    };
    const body = Buffer.from(
      JSON.stringify({ kind: 'fixture-workspace', businessId: job.businessId, summary }),
    );
    const key = `generation/${job.organizationId}/${job.id}/workspace-${createHash('sha256').update(body).digest('hex').slice(0, 16)}.json`;
    await this.writeBundle(key, body);
    return { bundleRef: key, summary };
  }
}

/** The schema and semantic validators as the only gate: errors → a repair (when possible) or a review. */
export class SchemaOnlyQualityPipeline implements QualityPipeline {
  constructor(
    private readonly assetHosts: readonly string[],
    private readonly hotlinkHosts: readonly string[] = [],
  ) {}

  async evaluate(input: Parameters<QualityPipeline['evaluate']>[0]) {
    const issues: Issue[] = validateSite(input.spec, {
      assetHosts: [...this.assetHosts],
      hotlinkHosts: [...this.hotlinkHosts],
      mode: 'published',
    });
    const errors = issues.filter((issue) => issue.severity === 'error');
    const warnings = issues.length - errors.length;
    const score = Math.max(0, 100 - errors.length * 20 - warnings * 2);
    if (errors.length === 0) return { outcome: 'pass' as const, score, issues };
    if (input.supportsRepair && input.repairsLeft > 0)
      return { outcome: 'repair' as const, score, issues: errors };
    return { outcome: 'needs_review' as const, score, issues: errors };
  }
}

/** Every workspace's settings until BF-046's screen: the engines registered, failover in a sensible order. */
export class DefaultGenerationSettings implements GenerationSettingsReader {
  constructor(private readonly engines: () => readonly EngineId[]) {}

  async resolve(): Promise<GenerationSettings> {
    const registered = this.engines();
    // DECISION(BF-044): the coding agents first, then `blocks` as the fallback (ADR-0010: "default fallback
    // blocks"): a job only fails over to engines after its own, so a coding agent's job ends on blocks.
    const order: EngineId[] = ['claude-agent-sdk', 'claude-code', 'codex', 'blocks', 'fake'];
    return {
      allowedEngines: registered.length > 0 ? [...registered] : ['blocks'],
      defaultEngine: 'auto',
      engineConcurrency: {},
      failoverChain: order.filter((engine) => registered.includes(engine)),
      engineBudgetsUsd: { blocks: 0.5, 'claude-agent-sdk': 3, 'claude-code': 4, codex: 4, fake: 1 },
      maxAttemptsPerEngine: 2,
      autoPublishPreview: true,
      locales: ['fr', 'en'],
    };
  }
}
