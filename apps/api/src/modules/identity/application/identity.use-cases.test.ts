import { ConflictError, ForbiddenError, fixedClock, NotFoundError } from '@bf/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { CreateApiKeyCommand, ListApiKeysQuery, RevokeApiKeyCommand } from './api-keys.commands.ts';
import { GetMeQuery } from './get-me.query.ts';
import {
  INVITATION_TTL_MS,
  InvitationMailer,
  InviteMemberCommand,
  ResendInvitationCommand,
  RevokeInvitationCommand,
} from './invitations.commands.ts';
import { ListMembersQuery } from './members.query.ts';
import {
  ChangeMemberRoleCommand,
  RemoveMemberCommand,
  TransferOwnershipCommand,
} from './membership.commands.ts';
import {
  apiKeyAuth,
  InMemoryApiKeys,
  InMemoryMembers,
  RecordingEvents,
  RecordingMailer,
  session,
  useFakeTransactions,
} from './testing.ts';

const APP = 'https://app.test';
const clock = fixedClock('2026-10-14T12:00:00.000Z');

let members: InMemoryMembers;
let keys: InMemoryApiKeys;
let events: RecordingEvents;
let mailer: RecordingMailer;

beforeEach(() => {
  useFakeTransactions();
  members = new InMemoryMembers();
  keys = new InMemoryApiKeys();
  events = new RecordingEvents();
  mailer = new RecordingMailer();
});

function workspace() {
  const org = members.addOrg('Agence');
  const olive = members.addUser('Olive');
  const adam = members.addUser('Adam');
  const vic = members.addUser('Vic');
  const owner = members.join(olive, org, 'owner');
  const admin = members.join(adam, org, 'admin');
  const viewer = members.join(vic, org, 'viewer');
  return {
    org,
    owner: { member: owner, auth: session(olive.id, org.id, 'owner') },
    admin: { member: admin, auth: session(adam.id, org.id, 'admin') },
    viewer: { member: viewer, auth: session(vic.id, org.id, 'viewer') },
  };
}

const catchError = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('GetMeQuery', () => {
  it('describes the user, the active workspace and all memberships', async () => {
    const { org, owner } = workspace();
    const other = members.addOrg('Zeta');
    members.join(members.users.get(owner.auth.userId ?? '') as never, other, 'viewer');
    const me = await new GetMeQuery(members).execute(owner.auth);
    expect(me.activeOrganization).toMatchObject({ id: org.id, role: 'owner' });
    expect(me.role).toBe('owner');
    expect(me.permissions).toContain('billing:manage');
    expect(me.organizations.map((o) => o.name)).toEqual(['Agence', 'Zeta']);
  });

  it('has no workspace fields without an active workspace, and refuses API keys', async () => {
    const lone = members.addUser('Lone');
    const me = await new GetMeQuery(members).execute(session(lone.id, null, null));
    expect(me).toMatchObject({ activeOrganization: null, role: null, permissions: [], organizations: [] });
    await expect(new GetMeQuery(members).execute(apiKeyAuth('org', ['business:read']))).rejects.toThrow(
      ForbiddenError,
    );
    await expect(new GetMeQuery(members).execute(session('missing', null, null))).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('invitations', () => {
  const invite = () =>
    new InviteMemberCommand(members, events, clock, APP, new InvitationMailer(members, mailer));

  it('creates an invitation expiring in 7 days, emails the accept link, then publishes the event', async () => {
    const { owner, org } = workspace();
    const invitation = await invite().execute(owner.auth, { email: 'new@example.test', role: 'member' });
    expect(invitation).toMatchObject({ email: 'new@example.test', role: 'member', status: 'pending' });
    expect(Date.parse(invitation.expiresAt)).toBe(clock.now().getTime() + INVITATION_TTL_MS);
    expect(mailer.invitations).toEqual([
      expect.objectContaining({
        to: 'new@example.test',
        url: `${APP}/invite/${invitation.id}`,
        organizationName: 'Agence',
        inviterName: 'Olive',
      }),
    ]);
    expect(events.events).toEqual([
      {
        type: 'identity.member_invited',
        organizationId: org.id,
        invitationId: invitation.id,
        role: 'member',
      },
    ]);
  });

  it('replaces a pending invitation for the same address', async () => {
    const { owner } = workspace();
    const first = await invite().execute(owner.auth, { email: 'again@example.test', role: 'viewer' });
    const second = await invite().execute(owner.auth, { email: 'again@example.test', role: 'admin' });
    expect(members.invitations.find((i) => i.id === first.id)?.status).toBe('canceled');
    expect(members.invitations.find((i) => i.id === second.id)?.status).toBe('pending');
  });

  it('refuses existing members, roles above the inviter, viewers and API keys', async () => {
    const { owner, admin, viewer, org } = workspace();
    expect(
      await catchError(invite().execute(owner.auth, { email: 'adam@example.test', role: 'viewer' })),
    ).toBeInstanceOf(ConflictError);
    expect(
      await catchError(invite().execute(admin.auth, { email: 'x@example.test', role: 'owner' })),
    ).toBeInstanceOf(ForbiddenError);
    expect(
      await catchError(invite().execute(viewer.auth, { email: 'x@example.test', role: 'viewer' })),
    ).toBeInstanceOf(ForbiddenError);
    expect(
      await catchError(
        invite().execute(apiKeyAuth(org.id, ['members:manage']), { email: 'x@example.test', role: 'viewer' }),
      ),
    ).toBeInstanceOf(ForbiddenError);
    expect(mailer.invitations).toEqual([]);
  });

  it('resends with a fresh expiry and revokes; unknown or settled invitations are not found', async () => {
    const { owner } = workspace();
    const invitation = await invite().execute(owner.auth, { email: 'r@example.test', role: 'member' });
    const later = fixedClock('2026-10-20T00:00:00.000Z');
    const resent = await new ResendInvitationCommand(
      members,
      later,
      APP,
      new InvitationMailer(members, mailer),
    ).execute(owner.auth, invitation.id);
    expect(Date.parse(resent.expiresAt)).toBe(later.now().getTime() + INVITATION_TTL_MS);
    expect(mailer.invitations).toHaveLength(2);

    const revoke = new RevokeInvitationCommand(members);
    await revoke.execute(owner.auth, invitation.id);
    expect(await catchError(revoke.execute(owner.auth, invitation.id))).toBeInstanceOf(NotFoundError);
    expect(await catchError(revoke.execute(owner.auth, 'nope'))).toBeInstanceOf(NotFoundError);
  });

  it('cannot see invitations of another workspace', async () => {
    const { owner } = workspace();
    const invitation = await invite().execute(owner.auth, { email: 'iso@example.test', role: 'member' });
    const otherOrg = members.addOrg('Other');
    const intruder = members.addUser('Intruder');
    members.join(intruder, otherOrg, 'owner');
    const auth = session(intruder.id, otherOrg.id, 'owner');
    expect(
      await catchError(new RevokeInvitationCommand(members).execute(auth, invitation.id)),
    ).toBeInstanceOf(NotFoundError);
  });

  it('lists members and pending invitations of the active workspace only', async () => {
    const { owner, org } = workspace();
    await invite().execute(owner.auth, { email: 'p@example.test', role: 'viewer' });
    members.join(members.addUser('Elsewhere'), members.addOrg('Other'), 'owner');
    const overview = await new ListMembersQuery(members).execute({ ...owner.auth, orgId: org.id });
    expect(overview.members.map((m) => m.name)).toEqual(['Olive', 'Adam', 'Vic']);
    expect(overview.invitations.map((i) => i.email)).toEqual(['p@example.test']);
  });
});

describe('membership changes', () => {
  it('changes a role and publishes the change; no-ops publish nothing', async () => {
    const { owner, viewer } = workspace();
    const command = new ChangeMemberRoleCommand(members, events);
    const changed = await command.execute(owner.auth, viewer.member.id, 'member');
    expect(changed.role).toBe('member');
    await command.execute(owner.auth, viewer.member.id, 'member');
    expect(events.events).toEqual([
      expect.objectContaining({ type: 'identity.member_role_changed', from: 'viewer', to: 'member' }),
    ]);
  });

  it('protects owners from admins and keeps a last owner', async () => {
    const { owner, admin } = workspace();
    const command = new ChangeMemberRoleCommand(members, events);
    expect(await catchError(command.execute(admin.auth, owner.member.id, 'admin'))).toBeInstanceOf(
      ForbiddenError,
    );
    expect(await catchError(command.execute(owner.auth, owner.member.id, 'admin'))).toBeInstanceOf(
      ConflictError,
    );
    expect(
      await catchError(new RemoveMemberCommand(members, events).execute(owner.auth, owner.member.id)),
    ).toBeInstanceOf(ConflictError);
  });

  it('removes members of the active workspace only', async () => {
    const { owner, viewer } = workspace();
    const remove = new RemoveMemberCommand(members, events);
    await remove.execute(owner.auth, viewer.member.id);
    expect(members.members.some((m) => m.id === viewer.member.id)).toBe(false);
    expect(events.events).toEqual([
      expect.objectContaining({ type: 'identity.member_removed', userId: viewer.member.userId }),
    ]);
    expect(await catchError(remove.execute(owner.auth, viewer.member.id))).toBeInstanceOf(NotFoundError);
  });

  it('transfers ownership: target becomes owner, previous owner admin', async () => {
    const { owner, admin } = workspace();
    await new TransferOwnershipCommand(members, events).execute(owner.auth, admin.member.id);
    expect(members.members.find((m) => m.id === admin.member.id)?.role).toBe('owner');
    expect(members.members.find((m) => m.id === owner.member.id)?.role).toBe('admin');
    expect(events.events.map((e) => e.type)).toEqual([
      'identity.member_role_changed',
      'identity.member_role_changed',
    ]);
    expect(
      await catchError(new TransferOwnershipCommand(members, events).execute(admin.auth, admin.member.id)),
    ).toBeInstanceOf(ConflictError);
  });

  it('needs the acting member to still belong to the workspace', async () => {
    const { owner, viewer } = workspace();
    await members.removeMember(owner.member.id);
    expect(
      await catchError(new RemoveMemberCommand(members, events).execute(owner.auth, viewer.member.id)),
    ).toBeInstanceOf(NotFoundError);
  });
});

describe('API keys', () => {
  it('creates a key with a subset of the creator’s permissions and returns the secret once', async () => {
    const { admin, org } = workspace();
    const created = await new CreateApiKeyCommand(keys, keys, events).execute(admin.auth, {
      name: 'zapier',
      permissions: ['business:read', 'business:read', 'leads:read'],
      expiresInDays: 30,
    });
    expect(created).toMatchObject({
      name: 'zapier',
      permissions: ['business:read', 'leads:read'],
      createdBy: admin.auth.userId,
    });
    expect(created.key).toMatch(/^bf_/);
    expect(created.expiresAt).toBe('2026-11-13T12:00:00.000Z');
    expect(events.events).toEqual([
      { type: 'identity.api_key_created', organizationId: org.id, apiKeyId: created.id },
    ]);
    const listed = await new ListApiKeysQuery(keys).execute({ ...admin.auth, orgId: org.id });
    expect(listed.items[0]).not.toHaveProperty('key');
  });

  it('refuses permission escalation and creation with an API key', async () => {
    const { admin, org } = workspace();
    const command = new CreateApiKeyCommand(keys, keys, events);
    expect(
      await catchError(command.execute(admin.auth, { name: 'x', permissions: ['billing:manage'] })),
    ).toBeInstanceOf(ForbiddenError);
    expect(
      await catchError(
        command.execute(apiKeyAuth(org.id, ['settings:manage']), {
          name: 'x',
          permissions: ['settings:manage'],
        }),
      ),
    ).toBeInstanceOf(ForbiddenError);
    expect(keys.keys).toEqual([]);
  });

  it('revokes idempotently and never across workspaces', async () => {
    const { owner } = workspace();
    const created = await new CreateApiKeyCommand(keys, keys, events).execute(owner.auth, {
      name: 'k',
      permissions: ['business:read'],
    });
    const revoke = new RevokeApiKeyCommand(keys, events, clock);
    await revoke.execute(owner.auth, created.id);
    await revoke.execute(owner.auth, created.id);
    expect(keys.keys[0]?.revokedAt).toEqual(clock.now());
    expect(events.events.filter((e) => e.type === 'identity.api_key_revoked')).toHaveLength(1);

    const outsider = members.addUser('Out');
    const otherOrg = members.addOrg('Out');
    members.join(outsider, otherOrg, 'owner');
    expect(
      await catchError(revoke.execute(session(outsider.id, otherOrg.id, 'owner'), created.id)),
    ).toBeInstanceOf(NotFoundError);
  });
});
