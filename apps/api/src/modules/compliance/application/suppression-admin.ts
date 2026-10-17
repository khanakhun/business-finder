import {
  type CurrentSuppression,
  type ImportSuppressionsRequest,
  ImportSuppressionsRequestSchema,
  type ImportSuppressionsResult,
  type SuppressionEntry,
  type SuppressionQuery,
  SuppressionQuerySchema,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { AuditLogger } from '../../workspace/index.ts';
import { normalizeKey } from '../domain/normalizers.ts';
import { ComplianceService } from './compliance.service.ts';
import { SUPPRESSION_REPOSITORY, type SuppressionRepository } from './ports.ts';

// Suppression management (BF-055): search the current list or the log, add one, import a CSV (preview first, then
// commit; normalized, deduplicated, already-suppressed skipped), export (audited). Revocation is ComplianceService's.

const PAGE = 100;
const MAX_IMPORT_ROWS = 10_000;
const CHECK_CHUNK = 100;

/** The values of a CSV: a `value`/`email` column when there is a header, else the first column. */
export function csvValues(csv: string): { line: number; value: string }[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const split = (line: string) =>
    line.split(/[,;\t]/).map((cell) =>
      cell
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim(),
    );
  const header = split(lines[0] ?? '').map((cell) => cell.toLowerCase());
  const column = header.findIndex((cell) => ['value', 'email', 'e-mail', 'domain', 'phone'].includes(cell));
  const start = column >= 0 ? 1 : 0;
  const index = column >= 0 ? column : 0;
  const out: { line: number; value: string }[] = [];
  for (let i = start; i < lines.length; i++) {
    const value = split(lines[i] ?? '')[index] ?? '';
    if (value) out.push({ line: i + 1, value });
  }
  return out;
}

const csvCell = (value: string) => (/[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

@Injectable()
export class SuppressionAdmin {
  constructor(
    @Inject(SUPPRESSION_REPOSITORY) private readonly suppressions: SuppressionRepository,
    private readonly compliance: ComplianceService,
    private readonly audit: AuditLogger,
  ) {}

  private filter(query: SuppressionQuery) {
    const parsed = SuppressionQuerySchema.parse(query);
    return {
      parsed,
      filter: {
        q: parsed.q,
        scope: parsed.scope,
        reason: parsed.reason,
        source: parsed.source,
        from: parsed.from ? new Date(parsed.from) : undefined,
        to: parsed.to ? new Date(parsed.to) : undefined,
        before: parsed.before ? new Date(parsed.before) : undefined,
        limit: PAGE,
      },
    };
  }

  async current(organizationId: string, query: SuppressionQuery) {
    const rows = await this.suppressions.searchCurrent(organizationId, this.filter(query).filter);
    const items: CurrentSuppression[] = rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
    return { items, nextCursor: rows.length === PAGE ? (items.at(-1)?.createdAt ?? null) : null };
  }

  async log(organizationId: string, query: SuppressionQuery) {
    const rows = await this.suppressions.searchLog(organizationId, this.filter(query).filter);
    const items: SuppressionEntry[] = rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    return { items, nextCursor: rows.length === PAGE ? (items.at(-1)?.createdAt ?? null) : null };
  }

  /**
   * CSV import (DECISION(BF-055): synchronous up to 10,000 rows within a 2 MB body — enough for a workspace's own
   * lists; a background job is a follow-up for larger files). Dry run first: nothing is written.
   */
  async import(
    organizationId: string,
    actor: { type: string; id: string | null },
    input: ImportSuppressionsRequest,
  ): Promise<ImportSuppressionsResult> {
    const request = ImportSuppressionsRequestSchema.parse(input);
    const rows = csvValues(request.csv).slice(0, MAX_IMPORT_ROWS);
    const invalid: ImportSuppressionsResult['invalid'] = [];
    let invalidCount = 0;
    const seen = new Set<string>();
    let duplicates = 0;
    for (const row of rows) {
      const value = normalizeKey(request.scope, row.value);
      if (!value) {
        invalidCount++;
        if (invalid.length < 50)
          invalid.push({
            line: row.line,
            value: row.value.slice(0, 120),
            message: `Not a valid ${request.scope}`,
          });
        continue;
      }
      if (seen.has(value)) duplicates++;
      else seen.add(value);
    }
    const values = [...seen];
    const already = new Set<string>();
    for (let i = 0; i < values.length; i += CHECK_CHUNK) {
      const chunk = values.slice(i, i + CHECK_CHUNK).map((value) => ({ scope: request.scope, value }));
      for (const hit of await this.suppressions.find(organizationId, chunk)) already.add(hit.value);
    }
    const fresh = values.filter((value) => !already.has(value));
    let added = 0;
    if (!request.dryRun) {
      for (const value of fresh) {
        const result = await this.compliance.suppress({
          organizationId,
          scope: request.scope,
          value,
          reason: request.reason,
          source: 'import',
          actor,
          note: request.note ?? null,
        });
        if (result.created) added++;
      }
      await this.audit.record({
        action: 'compliance.suppressions_imported',
        entityType: 'suppression',
        entityId: organizationId,
        metadata: { scope: request.scope, reason: request.reason, rows: rows.length, added },
      });
    }
    return {
      dryRun: request.dryRun,
      rows: rows.length,
      valid: values.length,
      duplicates,
      alreadySuppressed: already.size,
      added,
      invalid,
      invalidCount,
      sample: fresh.slice(0, 10),
    };
  }

  /** Every current suppression of the workspace (and the global ones) as CSV; audited. */
  async exportCsv(organizationId: string, query: SuppressionQuery): Promise<string> {
    const { filter } = this.filter(query);
    const lines = ['scope,value,reason,source,global,created_at'];
    let before: Date | undefined;
    for (;;) {
      const rows = await this.suppressions.searchCurrent(organizationId, { ...filter, before, limit: 1000 });
      for (const row of rows)
        lines.push(
          [row.scope, row.value, row.reason, row.source, String(row.global), row.createdAt.toISOString()]
            .map(csvCell)
            .join(','),
        );
      if (rows.length < 1000) break;
      before = rows.at(-1)?.createdAt;
    }
    await this.audit.record({
      action: 'compliance.suppressions_exported',
      entityType: 'suppression',
      entityId: organizationId,
      metadata: { rows: lines.length - 1 },
    });
    return `${lines.join('\n')}\n`;
  }
}
