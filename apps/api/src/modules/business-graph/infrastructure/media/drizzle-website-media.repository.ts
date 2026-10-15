import { type DbClient, getExecutor } from '@bf/db';
import { businessMedia } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type {
  WebsiteMediaItem,
  WebsiteMediaRepository,
} from '../../application/media/replace-website-media.command.ts';

@Injectable()
export class DrizzleWebsiteMediaRepository implements WebsiteMediaRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async replace(businessId: string, media: readonly WebsiteMediaItem[], locale: 'fr' | 'en'): Promise<void> {
    const x = getExecutor(this.db);
    await x
      .delete(businessMedia)
      .where(
        and(
          eq(businessMedia.businessId, businessId),
          eq(businessMedia.source, 'website'),
          isNull(businessMedia.storageKey),
        ),
      );
    if (media.length === 0) return;
    await x.insert(businessMedia).values(
      media.map((m) => ({
        businessId,
        kind: m.kind,
        externalUrl: m.url,
        source: 'website' as const,
        license: 'owner_site' as const,
        width: m.width && m.width > 0 ? m.width : null,
        height: m.height && m.height > 0 ? m.height : null,
        altText: m.altText ? { [locale]: m.altText } : null,
      })),
    );
  }
}
