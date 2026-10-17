import { type DbClient, getExecutor } from '@bf/db';
import { siteContactRouting } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import { SYSTEM_MAILER, type SystemMailer } from '../../identity/index.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { LiveLeadDelivery } from '../application/ports.ts';

// Live contact form delivery (BF-062): the message goes by the transactional (system) mailer to the business's
// confirmed address, and its copy address; nothing is sent while no address is confirmed (the lead stays stored).
// The message itself is the business's customer writing to the business: it is the email's content, never logged.

@Injectable()
export class SystemMailerLiveLeadDelivery implements LiveLeadDelivery {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(SYSTEM_MAILER) private readonly mailer: SystemMailer,
  ) {}

  async deliver(input: Parameters<LiveLeadDelivery['deliver']>[0]): Promise<boolean> {
    const [routing] = await getExecutor(this.db)
      .select({ to: siteContactRouting.recipientEmail, cc: siteContactRouting.cc })
      .from(siteContactRouting)
      .where(
        and(
          eq(siteContactRouting.siteId, input.siteId),
          eq(siteContactRouting.organizationId, input.organizationId),
          isNotNull(siteContactRouting.verifiedAt),
        ),
      );
    if (!routing?.to) return false;
    const fr = input.locale === 'fr';
    const { name, email, phone, message } = input.lead;
    const lines = [
      name ? `${fr ? 'Nom' : 'Name'} : ${name}` : null,
      email ? `E-mail : ${email}` : null,
      phone ? `${fr ? 'Téléphone' : 'Phone'} : ${phone}` : null,
      message ? `\n${message}` : null,
    ].filter((line): line is string => line !== null);
    const mail = {
      locale: fr ? ('fr' as const) : ('en' as const),
      title: fr
        ? `Nouveau message depuis le site ${input.businessName}`
        : `New message from the ${input.businessName} website`,
      body: lines.join('\n'),
      url: null,
    };
    await this.mailer.sendNotification({ ...mail, to: routing.to });
    if (routing.cc) await this.mailer.sendNotification({ ...mail, to: routing.cc });
    return true;
  }
}
