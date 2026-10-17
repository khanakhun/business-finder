import { type AiGateway, type EmailDraftInput, type EmailDraftOutput, OutreachEmailDraft } from '@bf/ai';
import {
  type ComplianceDecision,
  type CreateDraftRequest,
  CreateDraftRequestSchema,
  type DraftFactRef,
  type EmailDraft,
  type EmailLocale,
  type LintIssue,
  NotFoundError,
  type RegistryFact,
  type RenderedEmail,
  type TemplateValues,
  type UpdateDraftRequest,
  UpdateDraftRequestSchema,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ComplianceService, UnsubscribeService } from '../../../compliance/index.ts';
import { FactRegistryService } from '../../../generation/index.ts';
import { MemberDirectory } from '../../../identity/index.ts';
import { AI_GATEWAY } from '../../../platform/ai/ai.module.ts';
import { WorkspaceDefaults } from '../../../workspace/index.ts';
import { checkDraft } from '../../domain/drafting/draft-validators.ts';
import { composeFooter } from '../../domain/drafting/footer-composer.ts';
import { recipientLanguage } from '../../domain/drafting/language-policy.ts';
import { linksIn, linkViolations } from '../../domain/drafting/link-policy.ts';
import { OFFER_LABELS, THEME_PHRASES } from '../../domain/drafting/phrases.ts';
import { renderEmail } from '../../domain/drafting/renderer.ts';
import { MissingVariableError, renderTemplate } from '../../domain/drafting/template-engine.ts';
import { lintTemplate } from '../../domain/drafting/template-lint.ts';
import { MailboxCapacity } from '../mailbox/mailbox-capacity.ts';
import { MAILBOX_REPOSITORY, type MailboxRecord, type MailboxRepository } from '../mailbox/ports.ts';
import {
  DRAFT_CONTEXT,
  DRAFT_REPOSITORY,
  type DraftBusiness,
  type DraftContact,
  type DraftContextReader,
  type DraftRepository,
  type StoredDraft,
} from './ports.ts';
import { TemplatesService } from './templates.service.ts';

// Email drafts (BF-051). A draft is grounded in what we can prove — display facts, measured audit findings, review
// themes in general terms, the preview made for the business — and written either from a template (variables
// filled) or by the `outreach.email_draft` task (cited ids, validators, one repair). It never sends itself; the
// final rendering adds the signature and the deterministic compliance footer (the same composer as sending).

export interface DraftActor {
  readonly organizationId: string;
  readonly userId: string | null;
  readonly locale: EmailLocale;
}

interface Grounding {
  readonly business: DraftBusiness;
  readonly contact: DraftContact | null;
  readonly locale: EmailLocale;
  readonly facts: { id: string; text: string }[];
  readonly findings: { id: string; text: string; severity: 'low' | 'medium' | 'high' }[];
  readonly themes: { id: string; text: string; count: number }[];
  readonly preview: { siteId: string; url: string; expiresAt: Date | null } | null;
  readonly mailbox: MailboxRecord | null;
  readonly sender: { firstName: string; agencyName: string; agencyUrl: string | null };
}

const factText = (fact: RegistryFact): string => {
  const value = typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value);
  return `${fact.kind}: ${value}`.slice(0, 380);
};

export class DraftGenerationError extends ValidationError {}

export interface ComposedEmail {
  readonly rendered: ReturnType<typeof renderEmail>;
  readonly footer: string[];
  /** Problems that stop a send (no postal address). */
  readonly issues: LintIssue[];
  readonly contact: DraftContact | null;
  readonly mailbox: MailboxRecord | null;
  readonly previewUrl: string | null;
}

const withParam = (url: string, name: string, value: string) =>
  `${url}${url.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(value)}`;

@Injectable()
export class DraftsService {
  constructor(
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    @Inject(DRAFT_CONTEXT) private readonly context: DraftContextReader,
    @Inject(MAILBOX_REPOSITORY) private readonly mailboxes: MailboxRepository,
    @Inject(AI_GATEWAY) private readonly ai: AiGateway,
    private readonly templates: TemplatesService,
    private readonly facts: FactRegistryService,
    private readonly compliance: ComplianceService,
    private readonly unsubscribe: UnsubscribeService,
    private readonly workspace: WorkspaceDefaults,
    private readonly members: MemberDirectory,
    private readonly capacity: MailboxCapacity,
  ) {}

  // ── Reading ───────────────────────────────────────────────────────────────────────────────────────────────────

  private view(row: StoredDraft): EmailDraft {
    return {
      id: row.id,
      businessId: row.businessId,
      contactId: row.contactId,
      mailboxId: row.mailboxId,
      templateId: row.templateId,
      templateVersion: row.templateVersion,
      purpose: row.purpose,
      offer: row.offer,
      locale: row.locale,
      subject: row.subject,
      subjectVariants: row.subjectVariants,
      bodyMd: row.bodyMd,
      factsUsed: row.factsUsed,
      claims: row.claims,
      lint: row.lint,
      generatedBy: row.generatedBy,
      aiMeta: row.aiMeta,
      siteId: row.siteId,
      status: row.status,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async get(actor: DraftActor, id: string) {
    return this.view(await this.load(actor, id));
  }

  async forBusiness(actor: DraftActor, businessId: string) {
    return {
      items: (await this.drafts.forBusiness(actor.organizationId, businessId, 20)).map((row) =>
        this.view(row),
      ),
    };
  }

  // ── Writing ───────────────────────────────────────────────────────────────────────────────────────────────────

  async create(actor: DraftActor, input: CreateDraftRequest): Promise<EmailDraft> {
    const request = CreateDraftRequestSchema.parse(input);
    const ground = await this.ground(actor, {
      businessId: request.businessId,
      contactId: request.contactId,
      locale: request.locale,
      mailboxId: request.mailboxId,
    });
    const template = await this.templates.pick(
      { organizationId: actor.organizationId, userId: actor.userId },
      {
        templateId: request.templateId,
        purpose: request.purpose,
        offer: request.offer,
        locale: ground.locale,
        hasPreview: ground.preview !== null,
      },
    );
    const values = this.values(ground, request.offer);
    const filled = template ? this.fill(template.subjectVariants, template.bodyMd, values) : null;
    const base = {
      organizationId: actor.organizationId,
      businessId: ground.business.id,
      contactId: ground.contact?.id ?? null,
      mailboxId: ground.mailbox?.id ?? null,
      templateId: template?.id ?? null,
      templateVersion: template?.version ?? null,
      purpose: request.purpose,
      offer: request.offer,
      locale: ground.locale,
      siteId: ground.preview?.siteId ?? null,
      compliancePreview: null,
      status: 'draft' as const,
      createdBy: actor.userId,
    };
    if (request.mode === 'template') {
      if (!filled)
        throw new ValidationError('No template fits this purpose and language.', [], {
          details: { reason: 'NO_TEMPLATE' },
        });
      return this.view(
        await this.drafts.insert({
          ...base,
          subject: filled.subjects[0] ?? '',
          subjectVariants: filled.subjects,
          bodyMd: filled.body,
          factsUsed: this.refsFromTemplate(ground),
          claims: [],
          lint: this.lint(filled.subjects, filled.body, request.purpose, ground),
          generatedBy: 'template',
          aiMeta: null,
        }),
      );
    }
    const generated = await this.generate(actor, ground, {
      purpose: request.purpose,
      offer: request.offer,
      template: filled ? { subject: filled.subjects[0] ?? '', body: filled.body } : null,
      instructions: request.instructions ?? null,
    });
    return this.view(await this.drafts.insert({ ...base, ...generated }));
  }

  async regenerate(actor: DraftActor, id: string, instructions: string | undefined) {
    const draft = await this.load(actor, id);
    const ground = await this.ground(actor, {
      businessId: draft.businessId,
      contactId: draft.contactId,
      locale: draft.locale,
      mailboxId: draft.mailboxId ?? undefined,
    });
    const generated = await this.generate(actor, ground, {
      purpose: draft.purpose,
      offer: draft.offer,
      template: null,
      instructions: instructions ?? null,
    });
    return this.view(await this.drafts.update(actor.organizationId, id, generated));
  }

  /** The same message in the other language (facts kept: the current draft is the template). */
  async translate(actor: DraftActor, id: string, locale: EmailLocale) {
    const draft = await this.load(actor, id);
    if (draft.locale === locale) return this.view(draft);
    const ground = await this.ground(actor, {
      businessId: draft.businessId,
      contactId: draft.contactId,
      locale,
      mailboxId: draft.mailboxId ?? undefined,
    });
    const generated = await this.generate(actor, ground, {
      purpose: draft.purpose,
      offer: draft.offer,
      template: { subject: draft.subject, body: draft.bodyMd },
      instructions:
        locale === 'fr'
          ? 'Écrivez ce message en français, mêmes faits, même demande.'
          : 'Write this message in English: same facts, same ask.',
    });
    return this.view(await this.drafts.update(actor.organizationId, id, { ...generated, locale }));
  }

  /** Human edits: revalidated; the link policy blocks, the rest are warnings. */
  async update(actor: DraftActor, id: string, input: UpdateDraftRequest) {
    const patch = UpdateDraftRequestSchema.parse(input);
    const draft = await this.load(actor, id);
    if (draft.status === 'sent_as_message')
      throw new ValidationError('This draft was sent; it cannot change.', [], {
        details: { reason: 'SENT' },
      });
    const body = patch.bodyMd ?? draft.bodyMd;
    const subjects = patch.subjectVariants ?? draft.subjectVariants;
    const subject = patch.subject ?? draft.subject;
    const ground = await this.ground(actor, {
      businessId: draft.businessId,
      contactId: draft.contactId,
      locale: patch.locale ?? draft.locale,
      mailboxId: (patch.mailboxId === undefined ? draft.mailboxId : patch.mailboxId) ?? undefined,
    });
    const links = linkViolations(body, {
      previewUrl: ground.preview?.url ?? null,
      agencyUrl: ground.sender.agencyUrl,
    });
    if (links.disallowed.length > 0 || links.tooMany)
      throw new ValidationError(
        'Only the preview link (and your website) may appear in the email.',
        links.disallowed.map((url) => ({ path: ['bodyMd'], message: `Not allowed: ${url}` })),
        { details: { reason: 'LINK_POLICY' } },
      );
    const changedText =
      patch.bodyMd !== undefined || patch.subject !== undefined || patch.subjectVariants !== undefined;
    const updated = await this.drafts.update(actor.organizationId, id, {
      subject,
      subjectVariants: subjects.includes(subject) ? subjects : [subject, ...subjects].slice(0, 5),
      bodyMd: body,
      ...(patch.mailboxId !== undefined ? { mailboxId: patch.mailboxId } : {}),
      ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(changedText ? { generatedBy: 'human' as const } : {}),
      lint: this.lint([subject], body, draft.purpose, ground),
    });
    return this.view(updated);
  }

  /** The message exactly as it would go out now: body, signature, footer, plus the compliance decision (preview). */
  async preview(actor: DraftActor, id: string): Promise<RenderedEmail> {
    const draft = await this.load(actor, id);
    const decision = await this.compliance.evaluate(
      {
        organizationId: actor.organizationId,
        businessId: draft.businessId,
        ...(draft.contactId ? { contactId: draft.contactId } : {}),
      },
      'email',
      { purpose: draft.offer, stage: 'preview' },
    );
    // A preview shows the link's shape; the real token is issued at send time (fail-closed).
    const composed = await this.compose(actor, draft, {
      decision,
      unsubscribeUrl: this.unsubscribe.sampleUrl(),
    });
    return {
      ...composed.rendered,
      footer: composed.footer,
      links: linksIn(composed.rendered.text),
      compliance: decision as unknown as Record<string, unknown>,
      issues: [...draft.lint, ...composed.issues],
    };
  }

  /** A draft of the workspace (the outbound pipeline loads it before composing). */
  draft(actor: DraftActor, id: string): Promise<StoredDraft> {
    return this.load(actor, id);
  }

  /** Who the draft goes to: its contact, else the business's default contact. */
  async recipient(draft: StoredDraft): Promise<DraftContact | null> {
    const contact = draft.contactId
      ? await this.context.contact(draft.businessId, draft.contactId)
      : await this.context.defaultContact(draft.businessId);
    return contact ?? null;
  }

  /** The draft became a queued message (BF-052); `reopen` when that message is cancelled. */
  async markSent(actor: DraftActor, id: string): Promise<void> {
    await this.drafts.update(actor.organizationId, id, { status: 'sent_as_message' });
  }

  async reopen(actor: DraftActor, id: string): Promise<void> {
    const draft = await this.drafts.get(actor.organizationId, id);
    if (draft?.status === 'sent_as_message')
      await this.drafts.update(actor.organizationId, id, { status: 'draft' });
  }

  /**
   * The final rendering, shared by the preview and the send (BF-052): the body (the preview link carrying the
   * outreach token when sending), the mailbox signature and the deterministic footer from the decision's required
   * elements. What the person previews is what goes out, but for the two tokens.
   */
  async compose(
    actor: DraftActor,
    draft: StoredDraft,
    options: {
      readonly decision: ComplianceDecision;
      readonly unsubscribeUrl: string;
      readonly subject?: string | undefined;
      readonly mailboxId?: string | undefined;
      /** Appended to the preview link as `?r=` (attribution of the visit to this message). */
      readonly outreachToken?: string | undefined;
    },
  ): Promise<ComposedEmail> {
    const ground = await this.ground(actor, {
      businessId: draft.businessId,
      contactId: draft.contactId,
      locale: draft.locale,
      mailboxId: options.mailboxId ?? draft.mailboxId ?? undefined,
    });
    const identity = await this.workspace.identity(actor.organizationId);
    const address = identity.postalAddress
      ? [
          identity.postalAddress.line1,
          identity.postalAddress.line2,
          `${identity.postalAddress.postalCode} ${identity.postalAddress.city}`,
          identity.postalAddress.countryCode,
        ]
          .filter(Boolean)
          .join(', ')
      : null;
    const footer = composeFooter({
      locale: draft.locale,
      requiredElements: options.decision.requiredElements,
      agencyName: ground.sender.agencyName,
      legalName: identity.legalName,
      postalAddress: address,
      unsubscribeUrl: options.unsubscribeUrl,
      source: ground.contact?.publishedContext ?? 'unknown',
    });
    const previewUrl = ground.preview?.url ?? null;
    const bodyMd =
      previewUrl && options.outreachToken
        ? draft.bodyMd.split(previewUrl).join(withParam(previewUrl, 'r', options.outreachToken))
        : draft.bodyMd;
    const rendered = renderEmail({
      subject: options.subject ?? draft.subject,
      bodyMd,
      signatureMd: ground.mailbox?.signatureMd ?? `${ground.sender.firstName}\n${ground.sender.agencyName}`,
      footer,
      locale: draft.locale,
    });
    const issues: LintIssue[] = [];
    if (!identity.postalAddress)
      issues.push({
        code: 'no_postal_address',
        severity: 'error',
        message: 'Add the agency’s postal address in Settings → Workspace',
        at: null,
      });
    return { rendered, footer, issues, contact: ground.contact, mailbox: ground.mailbox, previewUrl };
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────────────────────

  private async load(actor: DraftActor, id: string) {
    const draft = await this.drafts.get(actor.organizationId, id);
    if (!draft) throw new NotFoundError('EmailDraft', id);
    return draft;
  }

  private async ground(
    actor: DraftActor,
    input: {
      businessId: string;
      contactId: string | null;
      locale?: EmailLocale | undefined;
      mailboxId?: string | undefined;
    },
  ): Promise<Grounding> {
    const business = await this.context.business(actor.organizationId, input.businessId);
    if (!business) throw new NotFoundError('Business', input.businessId);
    const registry = await this.facts.registry(
      { organizationId: actor.organizationId, userId: actor.userId },
      business.id,
    );
    const [contact, findings, themes, preview, siteLanguage, identity] = await Promise.all([
      input.contactId
        ? this.context.contact(business.id, input.contactId)
        : this.context.defaultContact(business.id),
      this.context.findings(business.id),
      this.context.reviewThemes(actor.organizationId, business.id),
      this.context.preview(actor.organizationId, business.id),
      this.context.siteLanguage(business.id),
      this.workspace.identity(actor.organizationId),
    ]);
    if (input.contactId && !contact) throw new NotFoundError('Contact', input.contactId);
    const locale =
      input.locale ??
      recipientLanguage({ siteLanguage, countryCode: business.countryCode, workspaceLocale: actor.locale })
        .locale;
    let mailbox: MailboxRecord | null = null;
    if (input.mailboxId) mailbox = (await this.mailboxes.find(actor.organizationId, input.mailboxId)) ?? null;
    else {
      const choice = await this.capacity.select({
        organizationId: actor.organizationId,
        stickyMailboxId: null,
        recipientLocale: locale,
        recipientTimeZone: null,
      });
      if (choice.ok) mailbox = (await this.mailboxes.find(actor.organizationId, choice.mailboxId)) ?? null;
    }
    const ownerName = mailbox?.ownerUserId
      ? (await this.members.contact(mailbox.ownerUserId))?.name
      : actor.userId
        ? (await this.members.contact(actor.userId))?.name
        : undefined;
    const agencyName = identity.agencyName ?? identity.legalName ?? mailbox?.displayName ?? '';
    return {
      business,
      contact: contact ?? null,
      locale,
      facts: registry.facts
        .filter((fact) => fact.usage === 'display')
        .slice(0, 60)
        .map((fact) => ({ id: fact.id, text: factText(fact) })),
      findings: findings.map((finding) => ({
        id: finding.id,
        text: `${finding.text[locale]}${finding.metric ? ` (${finding.metric.name}: ${finding.metric.value})` : ''}`,
        severity: finding.severity,
      })),
      themes: themes.flatMap((theme) => {
        const phrase = THEME_PHRASES[theme.tag as keyof typeof THEME_PHRASES];
        return phrase ? [{ id: theme.id, text: phrase[locale], count: theme.count }] : [];
      }),
      preview,
      mailbox,
      sender: {
        firstName: (ownerName ?? mailbox?.displayName ?? agencyName).split(/\s+/)[0] ?? agencyName,
        agencyName,
        agencyUrl: identity.websiteUrl,
      },
    };
  }

  private values(ground: Grounding, offer: StoredDraft['offer']): TemplateValues {
    const firstName = ground.contact?.personName?.split(/\s+/)[0];
    return {
      'business.name': ground.business.name,
      ...(ground.business.locality ? { 'business.locality': ground.business.locality } : {}),
      ...(ground.business.category
        ? { 'business.category': ground.business.category[ground.locale].toLowerCase() }
        : {}),
      ...(firstName ? { 'contact.firstName': firstName } : {}),
      'contact.isGeneric': ground.contact?.generic ?? true,
      ...(ground.preview ? { 'preview.url': ground.preview.url } : {}),
      ...(ground.preview?.expiresAt
        ? { 'preview.expiresAt': ground.preview.expiresAt.toISOString().slice(0, 10) }
        : {}),
      ...(ground.findings.length > 0
        ? { 'audit.topFindings': ground.findings.slice(0, 2).map((f) => f.text) }
        : {}),
      ...(ground.themes[0] ? { 'reviews.topTheme': ground.themes[0].text } : {}),
      'sender.firstName': ground.sender.firstName,
      'sender.agencyName': ground.sender.agencyName,
      'offer.label': OFFER_LABELS[offer][ground.locale],
    };
  }

  private fill(subjects: readonly string[], body: string, values: TemplateValues) {
    try {
      return {
        subjects: subjects.map((subject) => renderTemplate(subject, values)),
        body: renderTemplate(body, values),
      };
    } catch (error) {
      if (error instanceof MissingVariableError)
        throw new ValidationError(
          'This template needs information the business does not have yet.',
          error.names.map((name) => ({ path: ['template'], message: `Missing ${name}` })),
          { details: { reason: 'MISSING_VARIABLES', variables: error.names } },
        );
      throw error;
    }
  }

  private refsFromTemplate(ground: Grounding): DraftFactRef[] {
    return [
      ...ground.findings.slice(0, 2).map((f) => ({ kind: 'finding' as const, id: f.id, label: f.text })),
      ...(ground.themes[0]
        ? [{ kind: 'review_theme' as const, id: ground.themes[0].id, label: ground.themes[0].text }]
        : []),
      ...(ground.preview ? [{ kind: 'preview' as const, id: 'preview', label: ground.preview.url }] : []),
    ];
  }

  private lint(subjects: readonly string[], body: string, purpose: string, ground: Grounding): LintIssue[] {
    const issues = lintTemplate({
      subjects,
      body,
      purpose,
      locale: ground.locale,
      template: false,
    }).issues.filter((issue) => issue.code !== 'unknown_variable' && issue.code !== 'unguarded_optional');
    const links = linkViolations(body, {
      previewUrl: ground.preview?.url ?? null,
      agencyUrl: ground.sender.agencyUrl,
    });
    for (const url of links.disallowed)
      issues.push({
        code: 'link_policy',
        severity: 'error',
        message: `Link not allowed: ${url}`,
        at: 'body',
      });
    return issues;
  }

  /** The AI draft with validators and one repair; a second failure keeps the attempt with its problems as errors. */
  private async generate(
    actor: DraftActor,
    ground: Grounding,
    input: {
      purpose: StoredDraft['purpose'];
      offer: StoredDraft['offer'];
      template: { subject: string; body: string } | null;
      instructions: string | null;
    },
  ) {
    const ids = new Map<string, string>([
      ...ground.facts.map((f) => [f.id, f.text] as const),
      ...ground.findings.map((f) => [f.id, f.text] as const),
      ...ground.themes.map((t) => [t.id, t.text] as const),
      ...(ground.preview ? [['preview', ground.preview.url] as const] : []),
    ]);
    const request: EmailDraftInput = {
      locale: ground.locale,
      purpose: input.purpose,
      offer: OFFER_LABELS[input.offer][ground.locale],
      business: {
        name: ground.business.name,
        category: ground.business.category?.[ground.locale] ?? null,
        locality: ground.business.locality,
      },
      facts: ground.facts,
      findings: ground.findings,
      reviewThemes: ground.themes,
      preview: ground.preview ? { url: ground.preview.url, highlights: [] } : null,
      recipient: {
        firstName: ground.contact?.personName?.split(/\s+/)[0] ?? null,
        generic: ground.contact?.generic ?? true,
        role: null,
      },
      sender: { firstName: ground.sender.firstName, agencyName: ground.sender.agencyName },
      template: input.template,
      instructions: input.instructions,
      problems: null,
    };
    let costUsd = 0;
    let output: EmailDraftOutput | null = null;
    let problems: string[] = [];
    let model = '';
    let promptVersion: number | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.ai.run(
        OutreachEmailDraft,
        { ...request, problems: attempt === 0 ? null : problems },
        { orgId: actor.organizationId },
      );
      costUsd += result.costUsd ?? 0;
      model = result.model;
      promptVersion = result.promptVersion;
      output = result.output as EmailDraftOutput;
      const cited = [
        ...output.factsUsed,
        ...output.findingsUsed,
        ...output.themesUsed,
        ...output.claims.flatMap((c) => c.supportedBy),
      ];
      problems = checkDraft({
        subjects: output.subjectVariants,
        body: output.body,
        purpose: input.purpose,
        locale: ground.locale,
        ground: ids,
        cited,
        previewUrl: ground.preview?.url ?? null,
        agencyUrl: ground.sender.agencyUrl,
        freeText: [ground.business.name, ground.business.locality ?? ''],
      });
      if (problems.length === 0) break;
    }
    if (!output)
      throw new DraftGenerationError('The draft could not be written.', [], {
        details: { reason: 'DRAFT_FAILED' },
      });
    const label = (id: string) => ids.get(id) ?? id;
    const factsUsed: DraftFactRef[] = [
      ...output.factsUsed
        .filter((id) => ids.has(id))
        .map((id) => ({ kind: 'fact' as const, id, label: label(id) })),
      ...output.findingsUsed
        .filter((id) => ids.has(id))
        .map((id) => ({ kind: 'finding' as const, id, label: label(id) })),
      ...output.themesUsed
        .filter((id) => ids.has(id))
        .map((id) => ({ kind: 'review_theme' as const, id, label: label(id) })),
      ...(ground.preview && output.body.includes(ground.preview.url)
        ? [{ kind: 'preview' as const, id: 'preview', label: ground.preview.url }]
        : []),
    ];
    const lint = this.lint(output.subjectVariants, output.body, input.purpose, ground);
    for (const problem of problems)
      lint.push({ code: 'validator', severity: 'error', message: problem, at: 'body' });
    return {
      subject: output.subjectVariants[0] ?? '',
      subjectVariants: output.subjectVariants,
      bodyMd: output.body,
      factsUsed,
      claims: output.claims.map((claim) => ({
        text: claim.text,
        supportedBy: claim.supportedBy,
        supported: claim.supportedBy.length > 0 && claim.supportedBy.every((id) => ids.has(id)),
      })),
      lint,
      generatedBy: 'ai' as const,
      aiMeta: {
        model,
        promptVersion,
        costUsd,
        instructions: input.instructions,
        rationale: output.personalizationRationale,
        warnings: output.warnings,
        failed: problems.length > 0,
      },
    };
  }
}
