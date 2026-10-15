import type { ApiKeySummary, Invitation, Member } from '@bf/contracts';
import type { ApiKeyRecord, InvitationRecord, MemberRecord } from './ports.ts';

const iso = (date: Date) => date.toISOString();

export const toMember = (m: MemberRecord): Member => ({
  id: m.id,
  userId: m.userId,
  name: m.name,
  email: m.email,
  image: m.image,
  role: m.role,
  joinedAt: iso(m.createdAt),
});

export const toInvitation = (i: InvitationRecord): Invitation => ({
  id: i.id,
  email: i.email,
  role: i.role,
  status: i.status,
  expiresAt: iso(i.expiresAt),
  invitedBy: { id: i.inviterId, name: i.inviterName },
  createdAt: iso(i.createdAt),
});

export const toApiKeySummary = (k: ApiKeyRecord): ApiKeySummary => ({
  id: k.id,
  name: k.name,
  start: k.start,
  permissions: k.permissions,
  createdAt: iso(k.createdAt),
  createdBy: k.createdBy,
  lastUsedAt: k.lastUsedAt ? iso(k.lastUsedAt) : null,
  expiresAt: k.expiresAt ? iso(k.expiresAt) : null,
  revokedAt: k.revokedAt ? iso(k.revokedAt) : null,
});
