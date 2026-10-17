import {
  type EffectivePolicy,
  ForbiddenError,
  type LawfulBasisRecord,
  NotFoundError,
  type PolicyOverrideResult,
  type PolicyVersion,
  type ReviewPolicyRequest,
  type UpsertLawfulBasisRequest,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '../../platform/db/transactional.ts';
import { AuditLogger } from '../../workspace/index.ts';
import { overrideImpact } from '../domain/override-impact.ts';
import LIA_TEMPLATE from '../infrastructure/seeds/lia-template.json' with { type: 'json' };
import {
  LAWFUL_BASIS_REPOSITORY,
  type LawfulBasisRepository,
  POLICY_REPOSITORY,
  type PolicyRepository,
  type PolicyReview,
  type StoredLawfulBasis,
  type StoredPolicy,
} from './ports.ts';

// Settings → Compliance (BF-049): the effective policies with their review status, their versions, the legal review
// (with automatic sending turned on by an owner who may), stricter-only overrides with their impact, and the
// lawful-basis records (an LIA drafted from the template, approved, retired). Every change is audited.

export interface PolicyActor {
  readonly organizationId: string;
  readonly userId: string | null;
  /** May turn on automatic sending (`outreach:auto_send`). */
  readonly mayAutoSend: boolean;
}

const toVersion = (policy: StoredPolicy, review: PolicyReview | undefined): PolicyVersion => ({
  id: policy.id,
  jurisdiction: policy.jurisdiction,
  channel: policy.channel,
  version: policy.version,
  kind: policy.kind,
  policy: policy.rules,
  sources: policy.sources,
  needsLegalReview: policy.needsLegalReview && !review,
  reviewedBy: review?.reviewerName ?? null,
  reviewedAt: review?.reviewedAt.toISOString() ?? null,
  reviewNotes: review?.notes ?? null,
  createdAt: policy.createdAt.toISOString(),
});

const toLawfulBasis = (record: StoredLawfulBasis): LawfulBasisRecord => ({
  ...record,
  approvedBy: record.approvedBy,
  approvedAt: record.approvedAt?.toISOString() ?? null,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

@Injectable()
export class CompliancePolicies {
  constructor(
    @Inject(POLICY_REPOSITORY) private readonly policies: PolicyRepository,
    @Inject(LAWFUL_BASIS_REPOSITORY) private readonly lawfulBasis: LawfulBasisRepository,
    private readonly audit: AuditLogger,
  ) {}

  async effective(organizationId: string): Promise<EffectivePolicy[]> {
    const [seeds, overrides, reviews] = await Promise.all([
      this.policies.seeds(),
      this.policies.overrides(organizationId),
      this.policies.reviews(organizationId),
    ]);
    const reviewOf = new Map(reviews.map((review) => [review.policyId, review]));
    const overrideOf = new Map(
      overrides.map((policy) => [`${policy.jurisdiction}/${policy.channel}`, policy]),
    );
    return seeds
      .sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || a.channel.localeCompare(b.channel))
      .map((seed) => {
        const review = reviewOf.get(seed.id);
        const override = overrideOf.get(`${seed.jurisdiction}/${seed.channel}`);
        return {
          jurisdiction: seed.jurisdiction,
          channel: seed.channel,
          seed: toVersion(seed, review),
          override: override ? toVersion(override, reviewOf.get(override.id)) : null,
          autoSendEnabled: review?.autoSendEnabled ?? false,
        };
      });
  }

  async versions(organizationId: string, jurisdiction: string, channel: StoredPolicy['channel']) {
    const [rows, reviews] = await Promise.all([
      this.policies.versions(organizationId, jurisdiction, channel),
      this.policies.reviews(organizationId),
    ]);
    const reviewOf = new Map(reviews.map((review) => [review.policyId, review]));
    return rows.map((row) => toVersion(row, reviewOf.get(row.id)));
  }

  /** A legal review of a seed version for the workspace; automatic sending only by those who may turn it on. */
  @Transactional()
  async review(actor: PolicyActor, policyId: string, request: ReviewPolicyRequest): Promise<PolicyVersion> {
    const policy = await this.policies.byId(actor.organizationId, policyId);
    if (!policy || policy.kind !== 'seed') throw new NotFoundError('CompliancePolicy', policyId);
    const enableAutoSend = request.enableAutoSend ?? false;
    if (enableAutoSend && !actor.mayAutoSend)
      throw new ForbiddenError('Only an owner allowed to send automatically can turn on automatic sending.');
    const review = await this.policies.upsertReview({
      organizationId: actor.organizationId,
      policyId,
      reviewerName: request.reviewerName,
      notes: request.notes ?? '',
      autoSendEnabled: enableAutoSend,
      reviewedBy: actor.userId,
    });
    await this.audit.record({
      action: 'compliance.policy_reviewed',
      entityType: 'compliance_policy',
      entityId: policyId,
      metadata: {
        jurisdiction: policy.jurisdiction,
        channel: policy.channel,
        version: policy.version,
        reviewer: request.reviewerName,
        autoSendEnabled: enableAutoSend,
      },
    });
    return toVersion(policy, review);
  }

  /** A stricter-only override (the evaluator keeps the stricter of seed and override), with its impact. */
  @Transactional()
  async override(
    actor: PolicyActor,
    request: {
      jurisdiction: string;
      channel: StoredPolicy['channel'];
      policy: StoredPolicy['rules'];
      note?: string | undefined;
    },
  ): Promise<PolicyOverrideResult> {
    const seed = await this.policies.seed(request.jurisdiction, request.channel);
    if (!seed) throw new NotFoundError('CompliancePolicy', `${request.jurisdiction}/${request.channel}`);
    const impact = overrideImpact(seed.rules, request.policy);
    if (impact.stricter === 0)
      throw new ValidationError('This override changes nothing: overrides can only make a policy stricter.', [
        { path: ['policy'], message: 'No stricter outcome', code: 'no_effect' },
      ]);
    const created = await this.policies.insertOverride({
      organizationId: actor.organizationId,
      jurisdiction: request.jurisdiction,
      channel: request.channel,
      rules: request.policy,
      note: request.note ?? null,
      createdBy: actor.userId,
    });
    await this.audit.record({
      action: 'compliance.policy_overridden',
      entityType: 'compliance_policy',
      entityId: created.id,
      metadata: {
        jurisdiction: request.jurisdiction,
        channel: request.channel,
        version: created.version,
        stricter: impact.stricter,
      },
    });
    return { override: toVersion(created, undefined), impact };
  }

  // ── Lawful basis ────────────────────────────────────────────────────────────────────────────────────────────────

  async listLawfulBasis(organizationId: string) {
    return (await this.lawfulBasis.list(organizationId)).map(toLawfulBasis);
  }

  /** A new draft: from the request, or from the LIA template in the workspace's language. */
  async createLawfulBasis(actor: PolicyActor, request: UpsertLawfulBasisRequest | null, locale: 'en' | 'fr') {
    const template = LIA_TEMPLATE[locale];
    const record = await this.lawfulBasis.insert({
      organizationId: actor.organizationId,
      kind: request?.kind ?? 'legitimate_interest_assessment',
      title: request?.title ?? template.title,
      purpose: request?.purpose ?? template.purpose,
      dataCategories: request?.dataCategories ?? template.dataCategories,
      necessity: request?.necessity ?? template.necessity,
      balancingTest: request?.balancingTest ?? template.balancingTest,
      safeguards: request?.safeguards ?? template.safeguards,
      retention: request?.retention ?? template.retention,
      documentMd: request?.documentMd ?? template.documentMd,
    });
    return toLawfulBasis(record);
  }

  async updateLawfulBasis(actor: PolicyActor, id: string, request: UpsertLawfulBasisRequest) {
    const record = await this.lawfulBasis.get(actor.organizationId, id);
    if (!record) throw new NotFoundError('LawfulBasisRecord', id);
    if (record.status !== 'draft')
      throw new ValidationError(
        'Only a draft can be edited: create a new draft to change an approved record.',
        [{ path: ['status'], message: 'Not a draft', code: 'not_draft' }],
      );
    const { kind: _kind, ...patch } = request;
    const updated = await this.lawfulBasis.update(
      actor.organizationId,
      id,
      patch as Partial<StoredLawfulBasis>,
    );
    return toLawfulBasis(updated ?? record);
  }

  @Transactional()
  async setLawfulBasisStatus(actor: PolicyActor, id: string, status: 'approved' | 'retired') {
    const record = await this.lawfulBasis.get(actor.organizationId, id);
    if (!record) throw new NotFoundError('LawfulBasisRecord', id);
    const updated = await this.lawfulBasis.update(actor.organizationId, id, {
      status,
      ...(status === 'approved' ? { approvedBy: actor.userId, approvedAt: new Date() } : {}),
    });
    await this.audit.record({
      action: status === 'approved' ? 'compliance.lawful_basis_approved' : 'compliance.lawful_basis_retired',
      entityType: 'lawful_basis_record',
      entityId: id,
      metadata: { title: record.title, version: record.version },
    });
    return toLawfulBasis(updated ?? record);
  }
}
