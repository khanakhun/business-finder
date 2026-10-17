import { type DbClient, getExecutor } from '@bf/db';
import { outboundMessages, outboundMessageViews } from '@bf/db/schema';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import { SiteViewAttribution } from '../../../sites/index.ts';

// Preview views per outbound message (BF-053): a counted view of a preview carrying an email's `?r=` token adds to
// that message's views (first and last view, count). The token is an HMAC of the message id, so it cannot be forged;
// nothing about the visitor is stored. Sequence conditions (`previewViewed`) and stats read these rows.

@Injectable()
export class OutboundViewAttribution implements OnModuleInit {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    private readonly views: SiteViewAttribution,
  ) {}

  onModuleInit() {
    this.views.register(async ({ outreachToken, at }) => {
      const x = getExecutor(this.db);
      const [message] = await x
        .select({ id: outboundMessages.id })
        .from(outboundMessages)
        .where(eq(outboundMessages.outreachToken, outreachToken))
        .limit(1);
      if (!message) return;
      await x
        .insert(outboundMessageViews)
        .values({ outboundMessageId: message.id, firstViewedAt: at, lastViewedAt: at, views: 1 })
        .onConflictDoUpdate({
          target: outboundMessageViews.outboundMessageId,
          set: { lastViewedAt: at, views: sql`${outboundMessageViews.views} + 1` },
        });
    });
  }
}
