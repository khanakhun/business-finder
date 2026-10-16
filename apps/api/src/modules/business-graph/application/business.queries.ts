import {
  type BusinessDetail,
  type BusinessPage,
  type ContactList,
  type CursorPageRequest,
  decodeCursor,
  encodeCursor,
  NotFoundError,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { toContact } from './mappers.ts';
import {
  BUSINESS_READ_MODEL,
  type BusinessReadModel,
  CONTACT_REPOSITORY,
  type ContactRepository,
  ORG_BUSINESS_REPOSITORY,
  type OrgBusinessRepository,
  type TrackedPosition,
} from './ports.ts';
import { workspaceOf } from './workspace-of.ts';

/** Global facts plus the workspace's state; 404 unless the workspace tracks the business (ADR-0008). */
@Injectable()
export class GetBusinessDetailQuery {
  constructor(@Inject(BUSINESS_READ_MODEL) private readonly read: BusinessReadModel) {}

  async execute(auth: AuthContext, businessId: string): Promise<BusinessDetail> {
    const detail = await this.read.detail(workspaceOf(auth), businessId);
    if (!detail) throw new NotFoundError('Business', businessId);
    return detail;
  }
}

/** The workspace's businesses, most recently tracked first (filters and ranking come with search, BF-022). */
@Injectable()
export class ListTrackedBusinessesQuery {
  constructor(@Inject(BUSINESS_READ_MODEL) private readonly read: BusinessReadModel) {}

  async execute(auth: AuthContext, page: CursorPageRequest): Promise<BusinessPage> {
    const after = page.cursor ? await positionOf(page.cursor) : undefined;
    const rows = await this.read.listTracked(workspaceOf(auth), {
      limit: page.limit + 1,
      ...(after ? { after } : {}),
    });
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => row.summary),
      nextCursor:
        rows.length > page.limit && last
          ? await encodeCursor({
              sort: [last.position.trackedAt],
              id: last.position.businessId,
            })
          : null,
    };
  }
}

@Injectable()
export class ListContactsQuery {
  constructor(
    @Inject(ORG_BUSINESS_REPOSITORY) private readonly orgBusinesses: OrgBusinessRepository,
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository,
  ) {}

  async execute(auth: AuthContext, businessId: string): Promise<ContactList> {
    if (!(await this.orgBusinesses.find(workspaceOf(auth), businessId))) {
      throw new NotFoundError('Business', businessId);
    }
    const records = await this.contacts.listByBusiness(businessId);
    return { items: records.map(toContact) };
  }
}

const TRACKED_AT = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

async function positionOf(cursor: string): Promise<TrackedPosition> {
  const data = await decodeCursor(cursor);
  const [at] = data.sort;
  // Strict shape and bounded year: a tampered cursor is a 422, never a date Postgres rejects (500).
  const year = typeof at === 'string' ? Number(TRACKED_AT.exec(at)?.[1]) : Number.NaN;
  if (typeof at !== 'string' || !(year >= 2000 && year <= 2100) || !z.uuid().safeParse(data.id).success) {
    throw new ValidationError('Invalid cursor.', [{ path: ['cursor'], message: 'Invalid cursor' }]);
  }
  return { trackedAt: at, businessId: data.id };
}
