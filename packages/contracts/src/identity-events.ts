import { z } from 'zod';
import { defineEvent } from './events.ts';
import { RoleSchema } from './permissions.ts';

// Identity domain events (BF-010, delivered through the outbox since BF-012). Payloads carry ids, never emails.

export const UserSignedUp = defineEvent('identity.user_signed_up', 1, z.object({ userId: z.uuid() }));

export const MemberInvited = defineEvent(
  'identity.member_invited',
  1,
  z.object({ invitationId: z.uuid(), role: RoleSchema }),
);

export const InvitationResent = defineEvent(
  'identity.invitation_resent',
  1,
  z.object({ invitationId: z.uuid() }),
);

export const InvitationRevoked = defineEvent(
  'identity.invitation_revoked',
  1,
  z.object({ invitationId: z.uuid() }),
);

export const MemberJoined = defineEvent(
  'identity.member_joined',
  1,
  z.object({ memberId: z.uuid(), userId: z.uuid(), role: RoleSchema }),
);

export const MemberRoleChanged = defineEvent(
  'identity.member_role_changed',
  1,
  z.object({ memberId: z.uuid(), from: RoleSchema, to: RoleSchema }),
);

export const MemberRemoved = defineEvent(
  'identity.member_removed',
  1,
  z.object({ memberId: z.uuid(), userId: z.uuid() }),
);

export const ApiKeyCreated = defineEvent('identity.api_key_created', 1, z.object({ apiKeyId: z.uuid() }));

export const ApiKeyRevoked = defineEvent('identity.api_key_revoked', 1, z.object({ apiKeyId: z.uuid() }));

/** Every identity event, e.g. for subscribers that handle them all (audit). */
export const IDENTITY_EVENTS = [
  UserSignedUp,
  MemberInvited,
  InvitationResent,
  InvitationRevoked,
  MemberJoined,
  MemberRoleChanged,
  MemberRemoved,
  ApiKeyCreated,
  ApiKeyRevoked,
] as const;
