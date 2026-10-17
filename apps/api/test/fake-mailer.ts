import type { SystemMailer } from '../src/modules/identity/application/ports.ts';

export interface SentMail {
  readonly kind: 'verify' | 'reset' | 'invite' | 'two-factor' | 'magic-link' | 'notification';
  readonly subject?: string;
  readonly to: string;
  readonly url?: string;
  readonly locale: string;
}

/** Captures system emails so tests can follow their links (verification, invitations, resets). */
export class FakeMailer implements SystemMailer {
  readonly sent: SentMail[] = [];

  async sendVerificationEmail({ to, url, locale }: Parameters<SystemMailer['sendVerificationEmail']>[0]) {
    this.sent.push({ kind: 'verify', to, url, locale });
  }

  async sendPasswordReset({ to, url, locale }: Parameters<SystemMailer['sendPasswordReset']>[0]) {
    this.sent.push({ kind: 'reset', to, url, locale });
  }

  async sendInvitation({ to, url, locale }: Parameters<SystemMailer['sendInvitation']>[0]) {
    this.sent.push({ kind: 'invite', to, url, locale });
  }

  async sendTwoFactorEnabled({ to, locale }: Parameters<SystemMailer['sendTwoFactorEnabled']>[0]) {
    this.sent.push({ kind: 'two-factor', to, locale });
  }

  async sendMagicLink({ to, url, locale }: Parameters<SystemMailer['sendMagicLink']>[0]) {
    this.sent.push({ kind: 'magic-link', to, url, locale });
  }

  async sendNotification({ to, locale, title, url }: Parameters<SystemMailer['sendNotification']>[0]) {
    this.sent.push({ kind: 'notification', to, locale, subject: title, ...(url ? { url } : {}) });
  }

  /** The most recent link sent to `to` of the given kind. */
  lastUrl(kind: SentMail['kind'], to: string): string {
    const mail = this.sent.findLast((m) => m.kind === kind && m.to === to.toLowerCase());
    if (!mail?.url) throw new Error(`no ${kind} email with a link was sent to ${to}`);
    return mail.url;
  }
}
