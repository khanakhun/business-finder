// Public surface of the identity module (ARCHITECTURE.md §5.1): other modules import from here only.
export { type MemberContact, MemberDirectory } from './application/member-directory.ts';
export { type NotificationEmail, SYSTEM_MAILER, type SystemMailer } from './application/ports.ts';
