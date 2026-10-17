// Public surface of the outreach module (ARCHITECTURE.md §5.1): other modules import from here only.
export { MailboxCapacity, type SelectInput } from './application/mailbox/mailbox-capacity.ts';
export { MailboxesService } from './application/mailbox/mailboxes.service.ts';
export {
  MAILBOX_PROVIDERS,
  MAILBOX_REPOSITORY,
  type MailboxCtx,
  type MailboxProvider,
  type MailboxProviderRegistry,
  type MailboxRecord,
  type MailboxRepository,
  type RawInbound,
  type SyncCursor,
} from './application/mailbox/ports.ts';
export { OutreachModule } from './outreach.module.ts';
