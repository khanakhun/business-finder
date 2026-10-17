import { Injectable } from '@nestjs/common';
import { type ScopedSecretRef, SecretsVault } from '../../../workspace/index.ts';
import type { MailboxCredentials } from './ports.ts';

// A mailbox's credentials (OAuth tokens or an app password) as one sealed vault entry `mailbox:<id>` (security.md
// §2): decrypted just in time, never logged, never returned by the API.

export const secretRefOf = (mailboxId: string): ScopedSecretRef => `mailbox:${mailboxId}`;

@Injectable()
export class MailboxCredentialStore {
  constructor(private readonly vault: SecretsVault) {}

  async put(organizationId: string, mailboxId: string, credentials: MailboxCredentials, by: string | null) {
    const ref = secretRefOf(mailboxId);
    await this.vault.putScoped(organizationId, ref, JSON.stringify(credentials), by);
    return ref;
  }

  async get(organizationId: string, mailboxId: string): Promise<MailboxCredentials | undefined> {
    const value = await this.vault.getScoped(organizationId, secretRefOf(mailboxId));
    return value === undefined ? undefined : (JSON.parse(value) as MailboxCredentials);
  }

  delete(organizationId: string, mailboxId: string): Promise<boolean> {
    return this.vault.deleteScoped(organizationId, secretRefOf(mailboxId));
  }
}
