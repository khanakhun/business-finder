import {
  type BusinessExportQuery,
  type BusinessListItem,
  CONTACT_EXPORT_FIELDS,
  EXPORT_FIELDS,
  type ExportField,
  ForbiddenError,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { AuditLogger } from '../../workspace/index.ts';
import { type ListingPosition, parseSort, sortName } from '../domain/listing.ts';
import { ListingResolver } from './listing.queries.ts';
import {
  BUSINESS_SEARCH_REPOSITORY,
  type BusinessSearchRepository,
  type ExportExtras,
} from './listing-ports.ts';

const BATCH = 1_000;

/**
 * A CSV cell (RFC 4180). Text starting with `= + - @`, tab or CR is prefixed with `'` so spreadsheets never run
 * crawled text as a formula (CSV injection, OWASP); phone numbers (`+590…`) therefore read as text too.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // Numbers (a negative longitude) are data, never formulas; only text is neutralized.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const column = (field: ExportField, item: BusinessListItem, extras: ExportExtras | undefined) => {
  switch (field) {
    case 'id':
      return item.id;
    case 'name':
      return item.displayName;
    case 'category':
      return extras?.category ?? null;
    case 'website':
      return item.websiteUrl;
    case 'locality':
      return item.locality;
    case 'address':
      return extras?.address ?? null;
    case 'postal_code':
      return extras?.postalCode ?? null;
    case 'country':
      return item.countryCode;
    case 'lat':
      return item.location?.lat ?? null;
    case 'lng':
      return item.location?.lng ?? null;
    case 'rating':
      return item.ratingAvg;
    case 'reviews':
      return item.ratingCount;
    case 'status':
      return item.pipelineStatus;
    case 'score':
      return item.score;
    case 'tier':
      return item.tier;
    case 'tags':
      return item.tags.join(';');
    case 'tracked_at':
      return item.trackedAt;
    case 'phone':
      return item.primaryPhone;
    case 'email':
      return extras?.email ?? null;
  }
};

/**
 * Streams the listing as CSV (BF-022): same filters and sort as `GET /v1/businesses`, at most
 * `SEARCH_EXPORT_MAX_ROWS` rows, contact columns only with `outreach:send`, one audit entry per export.
 */
@Injectable()
export class ExportBusinesses {
  constructor(
    private readonly resolver: ListingResolver,
    @Inject(BUSINESS_SEARCH_REPOSITORY) private readonly repository: BusinessSearchRepository,
    private readonly audit: AuditLogger,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /** Checks the request before anything is written (so errors are still problem+json). */
  fieldsFor(auth: AuthContext, query: BusinessExportQuery): ExportField[] {
    const contacts = auth.permissions.has('outreach:send');
    if (!query.fields) return EXPORT_FIELDS.filter((f) => contacts || !CONTACT_EXPORT_FIELDS.has(f));
    const denied = query.fields.filter((f) => CONTACT_EXPORT_FIELDS.has(f));
    if (denied.length > 0 && !contacts) {
      throw new ForbiddenError(`Exporting ${denied.join(', ')} requires the outreach:send permission.`);
    }
    return [...new Set(query.fields)];
  }

  async *rows(
    auth: AuthContext,
    query: BusinessExportQuery,
    fields: readonly ExportField[],
  ): AsyncGenerator<string> {
    if (!auth.orgId) throw new Error('Export reached without an active workspace');
    const { sort: requested, fields: _fields, lang, ...filters } = query;
    const spec = await this.resolver.spec(auth.orgId, filters);
    const sort = parseSort(requested, spec.text !== null);
    if (sort.key === 'distance' && !spec.origin) {
      throw new ValidationError('Sorting by distance needs `near` or `area`.', [
        { path: ['sort'], message: 'Needs near or area' },
      ]);
    }
    const max = this.env.SEARCH_EXPORT_MAX_ROWS;
    const withEmail = fields.includes('email');
    let written = 0;
    const batch = async (items: readonly BusinessListItem[]) => {
      const extras = await this.repository.exportExtras(
        items.map((i) => i.id),
        { lang, email: withEmail },
      );
      written += items.length;
      return items
        .map((item) => `${fields.map((f) => csvCell(column(f, item, extras.get(item.id)))).join(',')}\r\n`)
        .join('');
    };
    try {
      yield `${fields.join(',')}\r\n`;
      if (sort.key === 'relevance') {
        const ranked = (await this.resolver.rank(spec)).slice(0, max).map((r) => r.id);
        for (let offset = 0; offset < ranked.length; offset += BATCH) {
          const ids = ranked.slice(offset, offset + BATCH);
          const byId = new Map((await this.repository.byIds(spec, ids)).map((i) => [i.id as string, i]));
          yield await batch(ids.flatMap((id) => (byId.has(id) ? [byId.get(id) as BusinessListItem] : [])));
        }
        return;
      }
      let after: ListingPosition | null = null;
      while (written < max) {
        const want = Math.min(BATCH, max - written);
        const rows = await this.repository.page(spec, sort, after, want);
        const last = rows.at(-1);
        if (!last) break;
        yield await batch(rows.map((r) => r.item));
        if (rows.length < want) break;
        after = { sort: sortName(sort), value: last.cursorValue, id: last.item.id };
      }
    } finally {
      await this.audit.record({
        action: 'business.exported',
        entityType: 'business',
        metadata: {
          rows: written,
          fields: [...fields],
          sort: sortName(sort),
          filters: Object.entries(filters).flatMap(([key, value]) => (value === undefined ? [] : [key])),
        },
      });
    }
  }
}
