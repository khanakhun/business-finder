import { createHash } from 'node:crypto';
import {
  type AiGateway,
  type CallScriptInput,
  type CallScriptOutput,
  OutreachCallScript,
  OutreachWhatsAppMessage,
  type WhatsAppMessageOutput,
} from '@bf/ai';
import {
  type BestTime,
  type CallList,
  type CallScript,
  type CallScriptRequest,
  CallScriptRequestSchema,
  type CallWorkspace,
  type Clock,
  type ComplianceDecision,
  type LogOutcomeRequest,
  LogOutcomeRequestSchema,
  type LogOutcomeResult,
  NotFoundError,
  ValidationError,
  type WhatsAppDraft,
  type WhatsAppDraftRequest,
  WhatsAppDraftRequestSchema,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ComplianceService } from '../../../compliance/index.ts';
import { CrmPipeline } from '../../../crm/index.ts';
import { AI_GATEWAY } from '../../../platform/ai/ai.module.ts';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { Transactional } from '../../../platform/db/transactional.ts';
import { WorkspaceDefaults } from '../../../workspace/index.ts';
import { bestTimeToCall } from '../../domain/assist/best-time.ts';
import { type OutcomeEffect, outcomeEffects } from '../../domain/assist/outcome-policy.ts';
import { checkGrounded, waUrl } from '../../domain/assist/script-check.ts';
import { OFFER_LABELS } from '../../domain/drafting/phrases.ts';
import { addDays, localDate, zonedInstant } from '../../domain/mailbox/zoned-time.ts';
import { ComplianceRefusedError } from '../../domain/outbound/errors.ts';
import { type DraftActor, DraftsService, type Grounding } from '../drafting/drafts.service.ts';
import { DRAFT_CONTEXT, type DraftContextReader } from '../drafting/ports.ts';
import { ManualContactLogs } from '../outbound/manual-log.ts';
import {
  ASSIST_READER,
  type AssistBusiness,
  type AssistNumber,
  type AssistReader,
  CALL_SCRIPT_CACHE,
  type CallScriptCache,
} from './ports.ts';

// Call and WhatsApp assist (BF-057). People dial and send; this prepares and records. The workspace shows the phone
// and WhatsApp decisions of the compliance gate before any action (the app offers no tel:/wa.me link when blocked),
// the best time to call, and the history. Scripts are grounded like emails (cited ids, no invented numbers, one
// repair) and cached per business, offer, language and facts (cache-aside). Outcomes are manual contact logs (the
// gate at `manual_log`) whose effects come from the outcome policy table; the offline queue's key makes them
// exactly-once.

const PURPOSE = 'website_redesign';
const SUGGESTION_GAP_DAYS = 14;

const OPT_OUT = {
  en: 'Reply STOP and we won’t write again.',
  fr: 'Répondez STOP et nous ne vous écrirons plus.',
};

const REMINDERS = {
  en: [
    'If they ask not to be called again, thank them and log “Do not call”.',
    'If asked, say where you found the number.',
  ],
  fr: [
    'S’ils demandent à ne plus être appelés, remerciez-les et notez « Ne plus appeler ».',
    'Si on vous le demande, dites où vous avez trouvé le numéro.',
  ],
};

const SOURCES: Record<string, { en: string; fr: string }> = {
  website: { en: 'it is published on your website', fr: 'il est publié sur votre site' },
  google_places: { en: 'it is on your Google listing', fr: 'il figure sur votre fiche Google' },
  gmaps_scraper: { en: 'it is on your Google listing', fr: 'il figure sur votre fiche Google' },
  osm: { en: 'it is listed on OpenStreetMap', fr: 'il figure sur OpenStreetMap' },
  foursquare: { en: 'it is listed on Foursquare', fr: 'il figure sur Foursquare' },
  overture: { en: 'it is in public business listings', fr: 'il figure dans des annuaires publics' },
};
const OTHER_SOURCE = { en: 'it is in public business listings', fr: 'il figure dans des annuaires publics' };

const OUTCOME_SUMMARY: Record<string, string> = {
  no_answer: 'No answer',
  voicemail: 'Voicemail left',
  interested: 'Spoke: interested',
  not_interested: 'Spoke: not interested',
  call_back: 'Spoke: call back later',
  info_email: 'Spoke: asked for information by email',
  info_whatsapp: 'Spoke: asked for information by WhatsApp',
  wrong_number: 'Wrong number',
  do_not_call: 'Asked not to be called again',
};

const TASK_TYPE: Record<string, 'call' | 'email' | 'follow_up'> = {
  'Call again': 'call',
  'Call again after the voicemail': 'call',
  'Call back as agreed': 'call',
  'Send the information by email': 'email',
};

const decisionView = (decision: ComplianceDecision) => ({
  decision: decision.decision,
  reasons: decision.reasons,
});

@Injectable()
export class CallAssist {
  constructor(
    @Inject(ASSIST_READER) private readonly reader: AssistReader,
    @Inject(CALL_SCRIPT_CACHE) private readonly cache: CallScriptCache,
    @Inject(DRAFT_CONTEXT) private readonly context: DraftContextReader,
    @Inject(AI_GATEWAY) private readonly ai: AiGateway,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly drafts: DraftsService,
    private readonly compliance: ComplianceService,
    private readonly manual: ManualContactLogs,
    private readonly crm: CrmPipeline,
    private readonly workspaceDefaults: WorkspaceDefaults,
  ) {}

  private async tracked(actor: DraftActor, businessId: string): Promise<AssistBusiness> {
    const business = await this.reader.business(actor.organizationId, businessId);
    if (!business) throw new NotFoundError('Business', businessId);
    return business;
  }

  private async numbers(actor: DraftActor, businessId: string) {
    const numbers = (await this.reader.numbers(actor.organizationId, [businessId])).get(businessId) ?? [];
    return {
      phone: numbers.find((number) => number.type === 'phone') ?? null,
      whatsapp: numbers.find((number) => number.type === 'whatsapp') ?? null,
    };
  }

  private gate(
    actor: DraftActor,
    businessId: string,
    channel: 'phone' | 'whatsapp',
    number: AssistNumber | null,
  ) {
    return this.compliance.evaluate(
      {
        organizationId: actor.organizationId,
        businessId,
        ...(number ? { contactId: number.contactId } : {}),
      },
      channel,
      { purpose: PURPOSE, stage: 'preview' },
    );
  }

  private async bestTime(
    organizationId: string,
    business: AssistBusiness,
    hours: Parameters<typeof bestTimeToCall>[0]['hours'],
  ): Promise<BestTime> {
    const timeZone = await this.workspaceDefaults.timeZone(organizationId);
    // DECISION(BF-057): a business's time zone is the workspace's (businesses carry no time zone yet).
    const result = bestTimeToCall({
      hours,
      categoryPath: business.categoryPath,
      timeZone,
      now: this.clock.now(),
    });
    return {
      goodNow: result.goodNow,
      nextAt: result.nextAt?.toISOString() ?? null,
      timeZone,
      reason: result.reason,
    };
  }

  // ── The call workspace ──────────────────────────────────────────────────────────────────────────────────────

  async workspace(actor: DraftActor, businessId: string): Promise<CallWorkspace> {
    const business = await this.tracked(actor, businessId);
    const { phone, whatsapp } = await this.numbers(actor, businessId);
    const [phoneDecision, whatsappDecision, preview, hours, history] = await Promise.all([
      this.gate(actor, businessId, 'phone', phone),
      this.gate(actor, businessId, 'whatsapp', whatsapp ?? phone),
      this.context.preview(actor.organizationId, businessId),
      this.reader.hours([businessId]),
      this.manual.forBusiness(actor, businessId),
    ]);
    return {
      businessId: business.id as never,
      businessName: business.name,
      phone: phone ? { contactId: phone.contactId, e164: phone.e164, label: phone.subtype } : null,
      whatsapp: whatsapp ? { contactId: whatsapp.contactId, e164: whatsapp.e164 } : null,
      previewUrl: preview?.url ?? null,
      compliance: { phone: decisionView(phoneDecision), whatsapp: decisionView(whatsappDecision) },
      doNotContact: business.doNotContact,
      bestTime: await this.bestTime(actor.organizationId, business, hours.get(businessId) ?? []),
      history,
    };
  }

  // ── The call script ─────────────────────────────────────────────────────────────────────────────────────────

  async callScript(actor: DraftActor, businessId: string, input: CallScriptRequest): Promise<CallScript> {
    const request = CallScriptRequestSchema.parse(input);
    await this.tracked(actor, businessId);
    const { phone } = await this.numbers(actor, businessId);
    const decision = await this.gate(actor, businessId, 'phone', phone);
    const ground = await this.drafts.grounding(actor, businessId, request.locale);
    const locale = ground.locale;
    const numberSource = (phone ? (SOURCES[phone.source] ?? OTHER_SOURCE) : OTHER_SOURCE)[locale];
    const conditions =
      decision.decision === 'allowed' ? [] : decision.reasons.map((reason) => reason.message[locale]);
    const reminders = [...conditions, ...REMINDERS[locale]];
    const factsHash = createHash('sha256')
      .update(
        JSON.stringify([
          ground.facts,
          ground.findings,
          ground.themes,
          ground.preview?.url,
          numberSource,
          conditions,
        ]),
      )
      .digest('hex')
      .slice(0, 40);
    const key = { organizationId: actor.organizationId, businessId, offer: request.offer, locale, factsHash };
    if (!request.regenerate) {
      const cached = await this.cache.find(key);
      if (cached) return { ...cached, cached: true };
    }
    const output = await this.generateScript(actor, ground, {
      offer: OFFER_LABELS[request.offer][locale],
      numberSource,
      conditions,
    });
    const script: Omit<CallScript, 'cached'> = {
      opener: output.opener,
      observations: output.observations.map((item) => ({ text: item.text, sourceIds: item.sourceIds })),
      previewMention: ground.preview ? output.previewMention : null,
      questions: output.questions,
      objections: output.objections,
      nextStep: output.nextStep,
      reminders,
      locale,
      generatedAt: this.clock.now().toISOString(),
    };
    await this.cache.save(key, script);
    return { ...script, cached: false };
  }

  private async generateScript(
    actor: DraftActor,
    ground: Grounding,
    extra: { offer: string; numberSource: string; conditions: string[] },
  ): Promise<CallScriptOutput> {
    const ids = new Map<string, string>([
      ...ground.facts.map((f) => [f.id, f.text] as const),
      ...ground.findings.map((f) => [f.id, f.text] as const),
      ...ground.themes.map((t) => [t.id, t.text] as const),
    ]);
    const request: CallScriptInput = {
      locale: ground.locale,
      offer: extra.offer,
      business: {
        name: ground.business.name,
        category: ground.business.category?.[ground.locale] ?? null,
        locality: ground.business.locality,
      },
      facts: ground.facts,
      findings: ground.findings,
      reviewThemes: ground.themes,
      preview: ground.preview ? { url: ground.preview.url } : null,
      contact: { personName: null, role: null },
      caller: { firstName: ground.sender.firstName, agencyName: ground.sender.agencyName },
      numberSource: extra.numberSource,
      conditions: extra.conditions,
      problems: null,
    };
    let problems: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.ai.run(
        OutreachCallScript,
        { ...request, problems: attempt === 0 ? null : problems },
        { orgId: actor.organizationId },
      );
      const output = result.output as CallScriptOutput;
      problems = checkGrounded({
        texts: [
          output.opener,
          ...output.observations.map((item) => item.text),
          output.previewMention ?? '',
          ...output.questions,
          ...output.objections.flatMap((item) => [item.objection, item.answer]),
          output.nextStep,
        ],
        cited: output.observations.flatMap((item) => item.sourceIds),
        ground: ids,
        // "Two minutes" may be written with a digit.
        freeText: [ground.business.name, ground.business.locality ?? '', '2'],
      });
      if (problems.length === 0) return output;
    }
    throw new ValidationError('The call script could not be written from what we know.', [], {
      details: { reason: 'SCRIPT_FAILED', problems },
    });
  }

  // ── WhatsApp ────────────────────────────────────────────────────────────────────────────────────────────────

  async whatsApp(actor: DraftActor, businessId: string, input: WhatsAppDraftRequest): Promise<WhatsAppDraft> {
    const request = WhatsAppDraftRequestSchema.parse(input);
    await this.tracked(actor, businessId);
    const { phone, whatsapp } = await this.numbers(actor, businessId);
    const target = whatsapp ?? (request.usePhone ? phone : null);
    if (!target)
      throw new ValidationError('This business has no WhatsApp number.', [
        { path: ['usePhone'], message: 'Confirm that the phone number is on WhatsApp' },
      ]);
    const decision = await this.gate(actor, businessId, 'whatsapp', target);
    if (decision.decision === 'blocked') throw new ComplianceRefusedError(decision, 'whatsapp');
    if (request.text)
      return { text: request.text, waUrl: waUrl(target.e164, request.text), e164: target.e164 };
    const ground = await this.drafts.grounding(actor, businessId, request.locale);
    const history = await this.manual.forBusiness(actor, businessId);
    const since = this.clock.now().getTime() - 2 * 86_400_000;
    const afterCall = history.some((log) => log.channel === 'phone' && Date.parse(log.createdAt) >= since);
    const body = await this.generateWhatsApp(actor, ground, afterCall);
    const locale = ground.locale;
    const text = [body, ground.preview?.url, OPT_OUT[locale]].filter(Boolean).join('\n\n');
    return { text, waUrl: waUrl(target.e164, text), e164: target.e164 };
  }

  private async generateWhatsApp(actor: DraftActor, ground: Grounding, afterCall: boolean): Promise<string> {
    const highlights = [
      ...ground.findings.slice(0, 2).map((f) => ({ id: f.id, text: f.text })),
      ...ground.themes.slice(0, 1).map((t) => ({ id: t.id, text: t.text })),
    ];
    const ids = new Map(highlights.map((item) => [item.id, item.text] as const));
    const firstName = ground.contact?.personName?.split(/\s+/)[0] ?? null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.ai.run(
        OutreachWhatsAppMessage,
        {
          locale: ground.locale,
          offer: OFFER_LABELS.website_redesign[ground.locale],
          business: {
            name: ground.business.name,
            category: ground.business.category?.[ground.locale] ?? null,
          },
          highlights,
          hasPreview: ground.preview !== null,
          contactFirstName: firstName,
          sender: { firstName: ground.sender.firstName, agencyName: ground.sender.agencyName },
          afterCall,
        },
        { orgId: actor.organizationId },
      );
      const output = result.output as WhatsAppMessageOutput;
      const problems = checkGrounded({
        texts: [output.text],
        cited: [...ids.keys()],
        ground: ids,
        freeText: [ground.business.name],
      });
      if (problems.length === 0) return output.text.trim();
    }
    // Two invented details: a plain message instead (never one with an invented figure or link).
    const { firstName: sender, agencyName } = ground.sender;
    return ground.locale === 'fr'
      ? `Bonjour${firstName ? ` ${firstName}` : ''}, ici ${sender} de ${agencyName}. ${
          ground.preview
            ? 'Nous avons préparé une idée de site pour vous, sans engagement : le lien est ci-dessous.'
            : 'Nous aidons les entreprises locales avec leur site web.'
        }`
      : `Hi${firstName ? ` ${firstName}` : ''}, this is ${sender} from ${agencyName}. ${
          ground.preview
            ? 'We put together a free concept of what your website could look like, link below.'
            : 'We help local businesses with their websites.'
        }`;
  }

  // ── Outcomes ────────────────────────────────────────────────────────────────────────────────────────────────

  @Transactional()
  async logOutcome(
    actor: DraftActor,
    businessId: string,
    input: LogOutcomeRequest,
  ): Promise<LogOutcomeResult> {
    const request = LogOutcomeRequestSchema.parse(input);
    const policy = request.outcome
      ? outcomeEffects(request.outcome, request.doNotContact)
      : { effects: [], next: null };
    const existing = await this.manual.byKey(actor, request.idempotencyKey);
    if (existing) return { log: existing, next: policy.next, duplicate: true };
    const fallback = request.outcome
      ? `${request.channel === 'phone' ? 'Call' : 'WhatsApp'}: ${OUTCOME_SUMMARY[request.outcome]}`
      : request.channel === 'whatsapp'
        ? 'WhatsApp message sent'
        : 'Call';
    const log = await this.manual.log(
      actor,
      {
        businessId,
        contactId: request.contactId,
        channel: request.channel,
        summary: request.notes || fallback,
        ...(request.outcome ? { outcome: request.outcome } : {}),
        purpose: PURPOSE,
      },
      {
        idempotencyKey: request.idempotencyKey,
        durationSec: request.durationSec ?? null,
        callbackAt: request.callbackAt ? new Date(request.callbackAt) : null,
      },
    );
    for (const effect of policy.effects) await this.apply(actor, businessId, effect, request);
    return { log, next: policy.next, duplicate: false };
  }

  private async apply(
    actor: DraftActor,
    businessId: string,
    effect: OutcomeEffect,
    request: ReturnType<typeof LogOutcomeRequestSchema.parse>,
  ): Promise<void> {
    const org = actor.organizationId;
    switch (effect.kind) {
      case 'engaged':
        await this.crm.markEngaged(org, businessId);
        return;
      case 'task':
        await this.crm.followUp(org, businessId, {
          title: effect.title,
          type: TASK_TYPE[effect.title] ?? 'follow_up',
          dueAt: await this.dueAt(org, effect.when, request.callbackAt),
          assigneeId: actor.userId,
        });
        return;
      case 'do_not_contact':
        await this.crm.doNotContact(org, businessId, 'do_not_call');
        return;
      case 'suppress_phone':
      case 'contact_invalid': {
        const number = await this.numberOf(actor, businessId, request.contactId);
        if (!number) return;
        // DECISION(BF-057): a wrong number is suppressed for the workspace (reason `manual`) rather than flagged
        // invalid in the shared business graph, which one workspace's call should not rewrite.
        await this.compliance.suppress({
          organizationId: org,
          scope: 'phone',
          value: number.e164,
          reason: effect.kind === 'suppress_phone' ? 'opt_out' : 'manual',
          source: 'admin',
          actor: { type: 'user', id: actor.userId },
          note: effect.kind === 'suppress_phone' ? 'Asked not to be called again' : 'Wrong number',
        });
        return;
      }
    }
  }

  private async numberOf(actor: DraftActor, businessId: string, contactId: string | null) {
    const numbers = (await this.reader.numbers(actor.organizationId, [businessId])).get(businessId) ?? [];
    return (
      (contactId ? numbers.find((number) => number.contactId === contactId) : undefined) ??
      numbers.find((number) => number.type === 'phone') ??
      null
    );
  }

  private async dueAt(organizationId: string, when: 'today' | 'callback' | 'tomorrow', callbackAt?: string) {
    const now = this.clock.now();
    if (when === 'callback' && callbackAt) return new Date(callbackAt);
    if (when === 'today') return now;
    const timeZone = await this.workspaceDefaults.timeZone(organizationId);
    return zonedInstant(addDays(localDate(now, timeZone), 1), '10:00', timeZone);
  }

  // ── The call list ───────────────────────────────────────────────────────────────────────────────────────────

  async callList(actor: DraftActor): Promise<CallList> {
    const now = this.clock.now();
    const timeZone = await this.workspaceDefaults.timeZone(actor.organizationId);
    const endOfDay = zonedInstant(addDays(localDate(now, timeZone), 1), '00:00', timeZone);
    const taskRows = await this.reader.callTasks(actor.organizationId, actor.userId, endOfDay);
    const taskIds = new Set(taskRows.map((row) => row.businessId));
    const suggested = (
      await this.reader.suggestions(
        actor.organizationId,
        new Date(now.getTime() - SUGGESTION_GAP_DAYS * 86_400_000),
        30,
      )
    ).filter((id) => !taskIds.has(id));
    const ids = [...taskIds, ...suggested];
    const [businesses, numbers, hours] = await Promise.all([
      this.reader.businesses(actor.organizationId, ids),
      this.reader.numbers(actor.organizationId, ids),
      this.reader.hours(ids),
    ]);
    const byId = new Map(businesses.map((business) => [business.id, business]));
    const item = async (businessId: string, task: (typeof taskRows)[number] | null) => {
      const business = byId.get(businessId);
      const phone = numbers.get(businessId)?.find((number) => number.type === 'phone');
      if (!business || !phone || business.doNotContact) return null;
      const decision = await this.gate(actor, businessId, 'phone', phone);
      if (decision.decision === 'blocked') return null;
      const preview = await this.context.preview(actor.organizationId, businessId);
      return {
        businessId: business.id as never,
        businessName: business.name,
        tier: business.tier,
        phone: phone.e164,
        taskId: task?.taskId ?? null,
        taskTitle: task?.title ?? null,
        dueAt: task?.dueAt?.toISOString() ?? null,
        previewUrl: preview?.url ?? null,
        bestTime: await this.bestTime(actor.organizationId, business, hours.get(businessId) ?? []),
      };
    };
    const tasks = (await Promise.all(taskRows.map((row) => item(row.businessId, row)))).filter(
      (x) => x !== null,
    );
    const suggestions = (await Promise.all(suggested.map((id) => item(id, null))))
      .filter((x) => x !== null)
      .filter((x) => x.bestTime.goodNow)
      .slice(0, 10);
    return { tasks, suggestions };
  }
}
