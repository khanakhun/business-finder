import { z } from 'zod';
import { LocaleSchema } from './i18n.ts';
import { PermissionSchema, RoleSchema } from './permissions.ts';
import { IsoDateTimeSchema } from './time.ts';

// Identity API shapes (BF-010): the current user, workspace members and invitations, API keys.

export const OrganizationSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    role: RoleSchema.describe("The caller's role in this workspace."),
  })
  .meta({ id: 'OrganizationSummary' });
export type OrganizationSummary = z.infer<typeof OrganizationSummarySchema>;

/** `GET /v1/me`. */
export const MeSchema = z
  .object({
    user: z.object({
      id: z.uuid(),
      name: z.string(),
      email: z.email(),
      emailVerified: z.boolean(),
      image: z.string().nullable(),
      locale: LocaleSchema,
      twoFactorEnabled: z.boolean(),
    }),
    activeOrganization: OrganizationSummarySchema.nullable(),
    role: RoleSchema.nullable(),
    permissions: z
      .array(PermissionSchema)
      .describe('Permissions in the active workspace (empty without one).'),
    organizations: z.array(OrganizationSummarySchema),
  })
  .meta({ id: 'Me', description: 'The signed-in user, their active workspace, role and permissions.' });
export type Me = z.infer<typeof MeSchema>;

export const MemberSchema = z
  .object({
    id: z.uuid().describe('Membership id.'),
    userId: z.uuid(),
    name: z.string(),
    email: z.email(),
    image: z.string().nullable(),
    role: RoleSchema,
    joinedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Member' });
export type Member = z.infer<typeof MemberSchema>;

export const InvitationSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    role: RoleSchema,
    status: z.enum(['pending', 'accepted', 'rejected', 'canceled']),
    expiresAt: IsoDateTimeSchema,
    invitedBy: z.object({ id: z.uuid(), name: z.string() }),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Invitation' });
export type Invitation = z.infer<typeof InvitationSchema>;

export const MembersOverviewSchema = z
  .object({ members: z.array(MemberSchema), invitations: z.array(InvitationSchema) })
  .meta({
    id: 'MembersOverview',
    description: 'Members of the active workspace and its pending invitations.',
  });
export type MembersOverview = z.infer<typeof MembersOverviewSchema>;

export const InviteMemberRequestSchema = z
  .object({
    email: z.email().transform((value) => value.trim().toLowerCase()),
    role: RoleSchema,
  })
  .meta({ id: 'InviteMemberRequest' });
export type InviteMemberRequest = z.infer<typeof InviteMemberRequestSchema>;

export const ChangeMemberRoleRequestSchema = z
  .object({ role: RoleSchema })
  .meta({ id: 'ChangeMemberRoleRequest' });
export type ChangeMemberRoleRequest = z.infer<typeof ChangeMemberRoleRequestSchema>;

export const TransferOwnershipRequestSchema = z
  .object({ memberId: z.uuid().describe('Membership that becomes owner; the current owner becomes admin.') })
  .meta({ id: 'TransferOwnershipRequest' });
export type TransferOwnershipRequest = z.infer<typeof TransferOwnershipRequestSchema>;

export const ApiKeySummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    start: z.string().nullable().describe('First characters of the key, e.g. `bf_Ab12`.'),
    permissions: z.array(PermissionSchema),
    createdAt: IsoDateTimeSchema,
    createdBy: z.uuid().nullable(),
    lastUsedAt: IsoDateTimeSchema.nullable(),
    expiresAt: IsoDateTimeSchema.nullable(),
    revokedAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'ApiKeySummary' });
export type ApiKeySummary = z.infer<typeof ApiKeySummarySchema>;

export const ApiKeyListSchema = z.object({ items: z.array(ApiKeySummarySchema) }).meta({ id: 'ApiKeyList' });
export type ApiKeyList = z.infer<typeof ApiKeyListSchema>;

export const CreateApiKeyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    permissions: z
      .array(PermissionSchema)
      .min(1)
      .describe("What the key may do; must be a subset of the creator's own permissions."),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Omit for a key that does not expire.'),
  })
  .meta({ id: 'CreateApiKeyRequest' });
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;

export const CreatedApiKeySchema = ApiKeySummarySchema.extend({
  key: z.string().describe('The secret key. Shown once; store it now — it cannot be retrieved again.'),
}).meta({ id: 'CreatedApiKey' });
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;

/** `GET /v1/identity/config` (public): what the sign-in and sign-up pages may offer. */
export const IdentityConfigSchema = z
  .object({
    signupMode: z.enum(['invite_only', 'allowlist', 'open']),
    googleEnabled: z.boolean(),
    minPasswordLength: z.number().int(),
  })
  .meta({ id: 'IdentityConfig' });
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;
