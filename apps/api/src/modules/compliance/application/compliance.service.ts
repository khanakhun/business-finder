import {
  type Clock,
  type ComplianceDecision,
  type ComplianceStage,
  ContactSuppressed,
  type EvaluationInputs,
  ForbiddenError,
  NotFoundError,
  type OutreachChannel,
  type SuppressionReason,
  type SuppressionScope,
  type SuppressionSource,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import { AuditLogger } from '../../workspace/index.ts';
import { alternativesFor } from '../domain/alternatives.ts';
import { normalizeKey } from '../domain/normalizers.ts';
import { type EvaluablePolicy, evaluatePolicy, type PolicySet } from '../domain/policy-evaluator.ts';
import { privacyHash } from '../domain/unsubscribe-token.ts';
import {
  COMPLIANCE_INPUTS,
  COMPLIANCE_TELEMETRY,
  type ComplianceInputs,
  type ComplianceTelemetry,
  DECISION_REPOSITORY,
  type DecisionRepository,
  POLICY_REPOSITORY,
  type PolicyRepository,
  SUPPRESSION_REPOSITORY,
  type SuppressionRepository,
  UNSUBSCRIBE_SETTINGS,
  type UnsubscribeSettings,
} from './ports.ts';

// The compliance gate (BF-049, ADR-0012): the only way to know whether a business may be contacted on a channel for
// a purpose. Inputs are gathered (jurisdiction, contact, markers, suppressions, workspace), the pure evaluator decides,
// enqueue/send/manual-log decisions are persisted with everything they were made from; previews are not. Plus the
// suppression core (append-only log, current projection, `contact.suppressed`).

/** A persisted enqueue decision is good for a day; send-stage decisions are for that moment only. */
const ENQUEUE_VALIDITY_MS = 24 * 60 * 60_000;

export interface ComplianceTarget {
  readonly organizationId: string;
  readonly businessId: string;
  readonly contactId?: string | undefined;
}

export interface EvaluateContext {
  readonly purpose: string;
  readonly stage: ComplianceStage;
}

@Injectable()
export class ComplianceService {
  constructor(
    @Inject(POLICY_REPOSITORY) private readonly policies: PolicyRepository,
    @Inject(DECISION_REPOSITORY) private readonly decisions: DecisionRepository,
    @Inject(SUPPRESSION_REPOSITORY) private readonly suppressions: SuppressionRepository,
    @Inject(COMPLIANCE_INPUTS) private readonly inputs: ComplianceInputs,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: EventRecorder,
    private readonly audit: AuditLogger,
    @Inject(UNSUBSCRIBE_SETTINGS) private readonly privacy: UnsubscribeSettings,
    @Optional() @Inject(COMPLIANCE_TELEMETRY) private readonly telemetry?: ComplianceTelemetry,
  ) {}

  /** Every email key also as its keyed hash: an erased address (BF-055) is still suppressed. */
  private withHashes(keys: readonly { scope: SuppressionScope; value: string }[]) {
    return [
      ...keys,
      ...keys
        .filter((key) => key.scope === 'email')
        .map((key) => ({
          scope: 'email_hash' as const,
          value: privacyHash(this.privacy.pepper, 'email', key.value),
        })),
    ];
  }

  /** The policies that apply: per candidate jurisdiction, its seed and the workspace's override. */
  private async policySets(
    organizationId: string,
    jurisdictions: readonly string[],
    channel: OutreachChannel,
  ) {
    const sets: PolicySet[] = [];
    for (const jurisdiction of jurisdictions) {
      const seed =
        (await this.policies.seed(jurisdiction, channel)) ?? (await this.policies.seed('*', channel));
      if (!seed) throw new NotFoundError('CompliancePolicy', `${jurisdiction}/${channel}`);
      const override = await this.policies.override(organizationId, seed.jurisdiction, channel);
      const evaluable = (policy: typeof seed): EvaluablePolicy => ({
        versionId: policy.id,
        jurisdiction: policy.jurisdiction,
        policy: policy.rules,
      });
      sets.push({ seed: evaluable(seed), ...(override ? { override: evaluable(override) } : {}) });
    }
    return sets;
  }

  /** Automatic sending is permitted only when every applicable seed was reviewed and its owner enabled it. */
  async isAutoSendPermitted(
    organizationId: string,
    jurisdictions: readonly string[],
    channel: OutreachChannel,
  ) {
    for (const jurisdiction of jurisdictions) {
      const seed = await this.policies.seed(jurisdiction, channel);
      if (!seed) return false;
      const review = await this.policies.review(organizationId, seed.id);
      if (!review?.autoSendEnabled) return false;
    }
    return true;
  }

  async evaluate(
    target: ComplianceTarget,
    channel: OutreachChannel,
    context: EvaluateContext,
  ): Promise<ComplianceDecision> {
    const started = performance.now();
    const gathered = await this.inputs.gather({ ...target, channel, purpose: context.purpose });
    const hits = await this.suppressions.find(
      target.organizationId,
      this.withHashes(gathered.suppressionKeys),
    );
    for (const hit of hits) this.telemetry?.suppressed(hit.scope);
    const inputs: EvaluationInputs = {
      ...gathered.inputs,
      jurisdictions: gathered.jurisdictions,
      channel,
      suppressed: hits.length > 0,
    };
    const result = evaluatePolicy(
      await this.policySets(target.organizationId, gathered.jurisdictions, channel),
      inputs,
    );
    const alternatives = alternativesFor(
      channel,
      result.decision,
      result.reasons.map((reason) => reason.code),
    );
    const autoSendPermitted =
      (result.decision === 'allowed' || result.decision === 'allowed_with_conditions') &&
      (await this.isAutoSendPermitted(target.organizationId, gathered.jurisdictions, channel));
    const now = this.clock.now();
    const validUntil = context.stage === 'enqueue' ? new Date(now.getTime() + ENQUEUE_VALIDITY_MS) : null;
    const decision: ComplianceDecision = {
      id: null,
      decision: result.decision,
      channel,
      stage: context.stage,
      jurisdictions: gathered.jurisdictions,
      reasons: result.reasons,
      requiredElements: result.requiredElements,
      alternatives,
      policyVersionIds: result.policyVersionIds,
      autoSendPermitted,
      inputs,
      evaluatedAt: now.toISOString(),
      validUntil: validUntil?.toISOString() ?? null,
    };
    const observe = () =>
      this.telemetry?.decided({
        stage: context.stage,
        channel,
        decision: result.decision,
        jurisdictions: gathered.jurisdictions,
        reason: result.reasons[0]?.code ?? 'none',
        seconds: (performance.now() - started) / 1000,
      });
    if (context.stage === 'preview') {
      observe();
      return decision;
    }
    const stored = await this.decisions.insert({
      organizationId: target.organizationId,
      businessId: target.businessId,
      contactId: target.contactId ?? null,
      channel,
      purpose: context.purpose,
      stage: context.stage,
      decision: result.decision,
      jurisdictions: gathered.jurisdictions,
      reasons: result.reasons,
      requiredElements: result.requiredElements,
      alternatives,
      inputs,
      policyVersionIds: result.policyVersionIds,
      lawfulBasisId: gathered.lawfulBasisId,
      validUntil,
    });
    observe();
    return { ...decision, id: stored.id, evaluatedAt: stored.evaluatedAt.toISOString() };
  }

  history(organizationId: string, businessId: string) {
    return this.decisions.forBusiness(organizationId, businessId, 50);
  }

  // ── Suppression ─────────────────────────────────────────────────────────────────────────────────────────────────

  @Transactional()
  async suppress(entry: {
    organizationId: string | null;
    scope: SuppressionScope;
    value: string;
    reason: SuppressionReason;
    source: SuppressionSource;
    actor: { type: string; id: string | null };
    note?: string | null;
  }): Promise<{ id: string; created: boolean }> {
    const value = normalizeKey(entry.scope, entry.value);
    if (!value)
      throw new ValidationError('This value cannot be suppressed.', [
        { path: ['value'], message: `Not a valid ${entry.scope}`, code: 'invalid' },
      ]);
    const result = await this.suppressions.add({ ...entry, value, note: entry.note ?? null });
    if (result.created && entry.organizationId)
      await this.events.record(ContactSuppressed, {
        orgId: entry.organizationId,
        payload: {
          entryId: result.id,
          scope: entry.scope,
          businessId: entry.scope === 'business' || entry.scope === 'org_business' ? (value as never) : null,
          reason: entry.reason,
        },
      });
    return result;
  }

  /** Lifts a workspace suppression (admins; audited). Global suppressions are not lifted from a workspace. */
  @Transactional()
  async revoke(
    organizationId: string,
    entryId: string,
    actor: { type: string; id: string | null },
    note: string,
    consentEvidence?: string,
  ) {
    const entry = await this.suppressions.entry(organizationId, entryId);
    if (!entry) throw new NotFoundError('SuppressionEntry', entryId);
    if (entry.organizationId === null)
      throw new ForbiddenError('A global suppression cannot be lifted by a workspace.');
    // Lifting an unsubscribe or opt-out needs documented new consent from the person (BF-055).
    const [current] = await this.suppressions.find(organizationId, [
      { scope: entry.scope, value: entry.value },
    ]);
    if (current && (current.reason === 'unsubscribe' || current.reason === 'opt_out') && !consentEvidence)
      throw new ValidationError(
        'This person unsubscribed: lifting it needs a record of their new consent.',
        [
          {
            path: ['consentEvidence'],
            message: 'Describe how and when they consented again',
            code: 'required',
          },
        ],
        { details: { reason: 'CONSENT_REQUIRED' } },
      );
    const revoked = await this.suppressions.revoke({
      organizationId,
      scope: entry.scope,
      value: entry.value,
      actor,
      note,
    });
    await this.audit.record({
      action: 'compliance.suppression_revoked',
      entityType: 'suppression',
      entityId: entryId,
      metadata: {
        scope: entry.scope,
        note: note.slice(0, 500),
        ...(consentEvidence ? { consentEvidence: consentEvidence.slice(0, 1000) } : {}),
      },
    });
    return revoked;
  }

  /** Which of the keys are suppressed for the workspace (exact on normalized values). */
  async isSuppressed(organizationId: string, keys: readonly { scope: SuppressionScope; value: string }[]) {
    const normalized = keys.flatMap((key) => {
      const value = normalizeKey(key.scope, key.value);
      return value ? [{ scope: key.scope, value }] : [];
    });
    return normalized.length === 0 ? [] : this.suppressions.find(organizationId, this.withHashes(normalized));
  }
}
