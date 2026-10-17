import {
  type Clock,
  type CreateDsrRequest,
  CreateDsrRequestSchema,
  type DataSubject,
  type DsrDiscovery,
  type DsrRequest,
  DsrRequestCreated,
  type DsrStatus,
  type ExecuteDsrRequest,
  ExecuteDsrRequestSchema,
  NotFoundError,
  newId,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { strToU8, zipSync } from 'fflate';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import type { ObjectStorage } from '../../platform/storage/object-storage.ts';
import { NotificationService } from '../../realtime/index.ts';
import { AuditLogger, SecretsVault } from '../../workspace/index.ts';
import { assertDsrTransition, dueReminders, isOpen } from '../domain/dsr-state-machine.ts';
import { normalizeKey } from '../domain/normalizers.ts';
import { privacyHash } from '../domain/unsubscribe-token.ts';
import { ComplianceService } from './compliance.service.ts';
import { type DataSubjectQuery, PersonalDataRegistry } from './personal-data.ts';
import {
  DSR_REPOSITORY,
  type DsrRepository,
  type StoredDsrRequest,
  UNSUBSCRIBE_SETTINGS,
  type UnsubscribeSettings,
} from './ports.ts';

// Data-subject requests (BF-055): create (admin or the public form) → verify (the method is recorded) → discover
// across the registered providers → execute (access: an encrypted ZIP export; erasure: delete/anonymize everywhere,
// keeping only a keyed-hash suppression so the person is never contacted again; objection: suppression and
// do-not-contact; rectification / restriction: recorded, with restriction blocking outreach) → completed. Every step
// is in the request's trail and the audit log; reminders 7 and 2 days before the one-month deadline.

export const DSR_EXPORT_STORAGE = Symbol('DsrExportStorage');
export const DSR_DUE_DAYS = 30;
const SEAL = 'dsr.subject';
const REMIND_EVERY_MS = 6 * 3_600_000;

export interface DsrActor {
  readonly organizationId: string;
  readonly userId: string | null;
}

const csvCell = (value: unknown) => {
  const text =
    value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function toCsv(rows: Record<string, unknown>[]): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return `${[columns.join(','), ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(','))].join('\n')}\n`;
}

@Injectable()
export class DsrService {
  constructor(
    @Inject(DSR_REPOSITORY) private readonly requests: DsrRepository,
    @Inject(DSR_EXPORT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(UNSUBSCRIBE_SETTINGS) private readonly privacy: UnsubscribeSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: PersonalDataRegistry,
    private readonly vault: SecretsVault,
    private readonly compliance: ComplianceService,
    private readonly events: EventRecorder,
    private readonly audit: AuditLogger,
    private readonly notifications: NotificationService,
  ) {}

  // ── Reading ───────────────────────────────────────────────────────────────────────────────────────────────────

  private subjectOf(row: StoredDsrRequest): DataSubject | null {
    if (!row.subjectSealed) return null;
    return JSON.parse(this.vault.openValue(row.organizationId, SEAL, row.subjectSealed)) as DataSubject;
  }

  private view(row: StoredDsrRequest): DsrRequest {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      source: row.source,
      subject: this.subjectOf(row),
      receivedAt: row.receivedAt.toISOString(),
      dueAt: row.dueAt.toISOString(),
      verification: row.verification as DsrRequest['verification'],
      actions: row.actions,
      exportReady: row.exportKey !== null,
      handledBy: row.handledBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(actor: DsrActor) {
    return { items: (await this.requests.list(actor.organizationId)).map((row) => this.view(row)) };
  }

  async get(actor: DsrActor, id: string) {
    return this.view(await this.load(actor, id));
  }

  // ── Workflow ──────────────────────────────────────────────────────────────────────────────────────────────────

  @Transactional()
  async create(
    actor: DsrActor,
    input: CreateDsrRequest,
    source: 'admin' | 'public' = 'admin',
  ): Promise<DsrRequest> {
    const request = CreateDsrRequestSchema.parse(input);
    const now = this.clock.now();
    const email = request.subject.email ? normalizeKey('email', request.subject.email) : null;
    const row = await this.requests.insert({
      organizationId: actor.organizationId,
      type: request.type,
      status: 'received',
      source,
      subjectSealed: this.vault.sealValue(actor.organizationId, SEAL, JSON.stringify(request.subject)),
      subjectHash: email ? privacyHash(this.privacy.pepper, 'email', email) : null,
      receivedAt: now,
      dueAt: new Date(now.getTime() + DSR_DUE_DAYS * 86_400_000),
      verification: null,
      actions: [
        {
          at: now.toISOString(),
          kind: 'received',
          by: actor.userId,
          detail: { notes: request.notes ?? null },
        },
      ],
      exportKey: null,
      handledBy: actor.userId,
      remindedAt: [],
    });
    await this.events.record(DsrRequestCreated, {
      orgId: actor.organizationId,
      payload: { requestId: row.id, type: row.type, source, dueAt: row.dueAt.toISOString() },
    });
    await this.audit.record({
      action: 'compliance.dsr_created',
      entityType: 'dsr_request',
      entityId: row.id,
      metadata: { type: row.type, source },
    });
    return this.view(row);
  }

  @Transactional()
  async verify(actor: DsrActor, id: string, input: { method: string; notes: string }) {
    const row = await this.load(actor, id);
    const now = this.clock.now().toISOString();
    return this.view(
      await this.move(
        actor,
        row,
        'in_progress',
        'verified',
        { method: input.method },
        {
          verification: { method: input.method, notes: input.notes, at: now, by: actor.userId },
        },
      ),
    );
  }

  @Transactional()
  async reject(actor: DsrActor, id: string, reason: string) {
    const row = await this.load(actor, id);
    return this.view(await this.move(actor, row, 'rejected', 'rejected', { reason }));
  }

  /** What every provider holds about the subject (redacted summaries; recorded in the trail). */
  async discover(actor: DsrActor, id: string): Promise<DsrDiscovery> {
    const row = await this.load(actor, id);
    const query = this.query(row);
    const providers = await Promise.all(
      this.registry.list().map(async (provider) => {
        const refs = await provider.find(query);
        return {
          id: provider.id,
          categories: [...provider.categories],
          records: refs.length,
          sample: refs.slice(0, 5).map((ref) => ref.summary.slice(0, 120)),
          manualReview: provider.manualReview ?? false,
        };
      }),
    );
    await this.requests.update(actor.organizationId, id, {
      actions: [
        ...row.actions,
        {
          at: this.clock.now().toISOString(),
          kind: 'discovered',
          by: actor.userId,
          detail: { providers: providers.map((p) => ({ id: p.id, records: p.records })) },
        },
      ],
    });
    return { providers };
  }

  /** Carries the request out (needs a recorded verification) and completes it. */
  async execute(actor: DsrActor, id: string, input: ExecuteDsrRequest): Promise<DsrRequest> {
    const options = ExecuteDsrRequestSchema.parse(input);
    const row = await this.load(actor, id);
    if (row.status !== 'in_progress')
      throw new ValidationError('Verify the person’s identity first.', [], {
        details: { reason: 'NOT_VERIFIED' },
      });
    const subject = this.subjectOf(row);
    if (!subject)
      throw new ValidationError('This request has no subject left.', [], {
        details: { reason: 'NO_SUBJECT' },
      });
    const query = this.query(row);
    const detail: Record<string, unknown> = { type: row.type };
    const patch: { -readonly [K in keyof StoredDsrRequest]?: StoredDsrRequest[K] } = {};
    switch (row.type) {
      case 'access': {
        const key = await this.exportZip(row, query);
        patch.exportKey = key;
        detail.files = true;
        break;
      }
      case 'erasure': {
        const results: Record<string, unknown> = {};
        for (const provider of this.registry.list()) {
          const refs = await provider.find(query);
          if (refs.length === 0) continue;
          results[provider.id] = await provider.erase(query, refs, options.mode);
        }
        // Never contact them again, without keeping the address: the keyed hash only.
        if (row.subjectHash) await this.suppressHash(row, 'legal');
        detail.mode = options.mode;
        detail.providers = results;
        // The request's own copy of the identifiers goes too (the hash stays for matching).
        patch.subjectSealed = null;
        break;
      }
      case 'objection': {
        if (subject.email)
          await this.compliance.suppress({
            organizationId: row.organizationId,
            scope: 'email',
            value: subject.email,
            reason: 'dsr_objection',
            source: 'admin',
            actor: { type: 'user', id: actor.userId },
          });
        if (subject.businessId)
          await this.compliance.suppress({
            organizationId: row.organizationId,
            scope: 'org_business',
            value: subject.businessId,
            reason: 'dsr_objection',
            source: 'admin',
            actor: { type: 'user', id: actor.userId },
          });
        break;
      }
      case 'restriction': {
        for (const provider of this.registry.list()) {
          if (!provider.restrict) continue;
          const refs = await provider.find(query);
          if (refs.length > 0) await provider.restrict(query, refs, true);
        }
        // Restricted processing includes outreach: suppressed until lifted.
        if (subject.email)
          await this.compliance.suppress({
            organizationId: row.organizationId,
            scope: 'email',
            value: subject.email,
            reason: 'legal',
            source: 'admin',
            actor: { type: 'user', id: actor.userId },
            note: 'Processing restricted (data-subject request)',
          });
        detail.notes = options.notes ?? null;
        break;
      }
      case 'rectification':
        detail.notes = options.notes ?? null;
        break;
    }
    const done = await this.move(
      actor,
      { ...row, ...patch } as StoredDsrRequest,
      'completed',
      'executed',
      detail,
      patch,
    );
    return this.view(done);
  }

  /** The access export (decrypted on the way out); audited. */
  async download(actor: DsrActor, id: string): Promise<Buffer> {
    const row = await this.load(actor, id);
    if (!row.exportKey) throw new NotFoundError('DsrExport', id);
    const object = await this.storage.get(row.exportKey);
    if (!object) throw new NotFoundError('DsrExport', id);
    const zip = Buffer.from(
      this.vault.openValue(row.organizationId, 'dsr.export', object.body.toString('utf8')),
      'base64',
    );
    await this.audit.record({
      action: 'compliance.dsr_export_downloaded',
      entityType: 'dsr_request',
      entityId: id,
      metadata: { bytes: zip.length },
    });
    return zip;
  }

  /** Reminders 7 and 2 days before the deadline (worker). */
  async remind(): Promise<number> {
    const now = this.clock.now();
    let sent = 0;
    for (const row of await this.requests.openDueBefore(new Date(now.getTime() + 7 * 86_400_000))) {
      const due = dueReminders(row.dueAt, now, row.remindedAt);
      if (due.length === 0) continue;
      await this.notifications.notify({
        organizationId: row.organizationId,
        recipients: row.handledBy ? [row.handledBy] : 'members',
        type: 'dsr_due',
        params: { type: row.type, when: row.dueAt.toISOString().slice(0, 10) },
        entity: { type: 'dsr_request', id: row.id },
        link: `/compliance/requests?request=${row.id}`,
        sourceEventId: `${row.id}:${Math.min(...due)}`,
      });
      await this.requests.update(row.organizationId, row.id, {
        remindedAt: [...row.remindedAt, ...due.map(String)],
      });
      sent++;
    }
    return sent;
  }

  /** Deletes access exports 30 days after completion (a retention policy). */
  async purgeExports(before: Date, limit: number): Promise<number> {
    const rows = await this.requests.exportsBefore(before, limit);
    for (const row of rows) {
      if (row.exportKey) await this.storage.delete(row.exportKey);
      await this.requests.update(row.organizationId, row.id, { exportKey: null });
    }
    return rows.length;
  }

  countExportsBefore(before: Date) {
    return this.requests.exportsBefore(before, 10_000).then((rows) => rows.length);
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────────────────────

  private async load(actor: DsrActor, id: string) {
    const row = await this.requests.get(actor.organizationId, id);
    if (!row) throw new NotFoundError('DsrRequest', id);
    return row;
  }

  private query(row: StoredDsrRequest): DataSubjectQuery {
    const subject = this.subjectOf(row);
    return {
      organizationId: row.organizationId,
      email: subject?.email ? (normalizeKey('email', subject.email) ?? undefined) : undefined,
      phone: subject?.phone ? (normalizeKey('phone', subject.phone) ?? subject.phone) : undefined,
      name: subject?.name,
      businessId: subject?.businessId,
      emailHash: row.subjectHash ?? undefined,
    };
  }

  private async suppressHash(row: StoredDsrRequest, reason: 'legal' | 'dsr_objection') {
    if (!row.subjectHash) return;
    await this.compliance.suppress({
      organizationId: row.organizationId,
      scope: 'email_hash',
      value: row.subjectHash,
      reason,
      source: 'admin',
      actor: { type: 'system', id: 'compliance.dsr' },
      note: 'Kept after erasure (keyed hash only)',
    });
  }

  private async exportZip(row: StoredDsrRequest, query: DataSubjectQuery): Promise<string> {
    const files: Record<string, Uint8Array> = {};
    const index: string[] = [];
    for (const provider of this.registry.list()) {
      const refs = await provider.find(query);
      if (refs.length === 0) continue;
      for (const chunk of await provider.export(query, refs)) {
        const base = `${provider.id}/${chunk.name}`;
        files[`${base}.json`] = strToU8(JSON.stringify(chunk.rows, null, 2));
        files[`${base}.csv`] = strToU8(toCsv(chunk.rows));
        index.push(`- ${base} (${chunk.rows.length} records; categories: ${provider.categories.join(', ')})`);
      }
    }
    files['README.md'] = strToU8(
      [
        '# Your personal data',
        '',
        `Export generated on ${this.clock.now().toISOString()} in answer to your access request.`,
        'Each folder is one place where data about you is kept, as JSON and as CSV.',
        '',
        ...(index.length > 0 ? index : ['No personal data about you was found.']),
        '',
      ].join('\n'),
    );
    const zip = Buffer.from(zipSync(files, { level: 6 }));
    const key = `${row.organizationId}/dsr/${row.id}/${newId()}.zip.sealed`;
    const sealed = this.vault.sealValue(row.organizationId, 'dsr.export', zip.toString('base64'));
    await this.storage.put(key, Buffer.from(sealed, 'utf8'), 'application/octet-stream');
    return key;
  }

  private async move(
    actor: DsrActor,
    row: StoredDsrRequest,
    to: DsrStatus,
    kind: string,
    detail: Record<string, unknown>,
    patch: Partial<StoredDsrRequest> = {},
  ): Promise<StoredDsrRequest> {
    if (!isOpen(row.status))
      throw new ValidationError('This request is closed.', [], { details: { reason: 'CLOSED' } });
    assertDsrTransition(row.status, to);
    const updated = await this.requests.update(actor.organizationId, row.id, {
      ...patch,
      status: to,
      handledBy: actor.userId ?? row.handledBy,
      actions: [...row.actions, { at: this.clock.now().toISOString(), kind, by: actor.userId, detail }],
    });
    await this.audit.record({
      action: `compliance.dsr_${kind}`,
      entityType: 'dsr_request',
      entityId: row.id,
      metadata: { type: row.type, status: to },
    });
    return updated;
  }
}

/** Deadline reminders every six hours (worker only). */
@Injectable()
export class DsrReminderSchedule implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly dsr: DsrService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit() {
    this.timer = setInterval(
      () => void this.dsr.remind().catch((err: unknown) => this.logger.warn({ err }, 'dsr reminders failed')),
      REMIND_EVERY_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
