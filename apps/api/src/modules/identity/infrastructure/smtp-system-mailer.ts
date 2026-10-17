import type { ApiEnv } from '@bf/config';
import type { Logger } from '@bf/observability';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { render } from '@react-email/components';
import { createTransport, type Transporter } from 'nodemailer';
import type * as React from 'react';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import type { SystemMailer } from '../application/ports.ts';
import { MESSAGES } from './emails/messages.ts';
import {
  Invitation,
  MagicLink,
  NotificationEmail,
  ResetPassword,
  TwoFactorEnabled,
  VerifyEmail,
} from './emails/templates.tsx';

/** Renders an email to HTML and plain text. Exported for tests and the template preview. */
export async function renderEmail(element: React.ReactElement): Promise<{ html: string; text: string }> {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { html, text };
}

/**
 * System mail over SMTP (Mailpit locally, a transactional provider in production) — never a prospecting
 * mailbox (ADR-0007). Recipients are not logged (PII); the template name and message id are.
 */
@Injectable()
export class SmtpSystemMailer implements SystemMailer, OnModuleDestroy {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(
    @Inject(APP_ENV) appEnv: AppEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    const env = appEnv as ApiEnv;
    this.transport = createTransport(env.SMTP_URL);
    this.from = env.MAIL_FROM;
  }

  onModuleDestroy(): void {
    this.transport.close();
  }

  private async send(template: string, to: string, subject: string, element: React.ReactElement) {
    const { html, text } = await renderEmail(element);
    const info = await this.transport.sendMail({ from: this.from, to, subject, html, text });
    this.logger.info({ template, messageId: info.messageId }, 'system email sent');
  }

  sendVerificationEmail({ to, name, url, locale }: Parameters<SystemMailer['sendVerificationEmail']>[0]) {
    return this.send('verify-email', to, MESSAGES[locale].verify.subject, VerifyEmail({ locale, name, url }));
  }

  sendPasswordReset({ to, name, url, locale }: Parameters<SystemMailer['sendPasswordReset']>[0]) {
    return this.send(
      'reset-password',
      to,
      MESSAGES[locale].reset.subject,
      ResetPassword({ locale, name, url }),
    );
  }

  sendInvitation(input: Parameters<SystemMailer['sendInvitation']>[0]) {
    const { to, locale, ...rest } = input;
    return this.send(
      'invitation',
      to,
      MESSAGES[locale].invite.subject(rest.organizationName),
      Invitation({ locale, ...rest }),
    );
  }

  sendTwoFactorEnabled({ to, name, locale }: Parameters<SystemMailer['sendTwoFactorEnabled']>[0]) {
    return this.send(
      'two-factor-enabled',
      to,
      MESSAGES[locale].twoFactor.subject,
      TwoFactorEnabled({ locale, name }),
    );
  }

  sendMagicLink({ to, url, locale }: Parameters<SystemMailer['sendMagicLink']>[0]) {
    return this.send('magic-link', to, MESSAGES[locale].magicLink.subject, MagicLink({ locale, url }));
  }

  sendNotification({ to, locale, title, body, url }: Parameters<SystemMailer['sendNotification']>[0]) {
    return this.send('notification', to, title, NotificationEmail({ locale, title, body, url }));
  }
}
