import {
  ChangeMemberRoleRequestSchema,
  type Invitation,
  InvitationSchema,
  InviteMemberRequestSchema,
  type Member,
  MemberSchema,
  type MembersOverview,
  MembersOverviewSchema,
  TransferOwnershipRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import {
  InviteMemberCommand,
  ResendInvitationCommand,
  RevokeInvitationCommand,
} from '../../application/invitations.commands.ts';
import { ListMembersQuery } from '../../application/members.query.ts';
import {
  ChangeMemberRoleCommand,
  RemoveMemberCommand,
  TransferOwnershipCommand,
} from '../../application/membership.commands.ts';

class InviteMemberBody extends zodDto(InviteMemberRequestSchema) {}
class ChangeMemberRoleBody extends zodDto(ChangeMemberRoleRequestSchema) {}
class TransferOwnershipBody extends zodDto(TransferOwnershipRequestSchema) {}

const uuid = new ParseUUIDPipe({ version: '7' });
type OrgAuth = AuthContext & { readonly orgId: string };

/** Members and invitations of the caller's active workspace (members:manage). */
@ApiTags('identity')
@Controller()
export class MembersController {
  constructor(
    private readonly listMembers: ListMembersQuery,
    private readonly inviteMember: InviteMemberCommand,
    private readonly resendInvitation: ResendInvitationCommand,
    private readonly revokeInvitation: RevokeInvitationCommand,
    private readonly changeRole: ChangeMemberRoleCommand,
    private readonly removeMember: RemoveMemberCommand,
    private readonly transferOwnership: TransferOwnershipCommand,
  ) {}

  @Get('members')
  @RequirePermission('members:manage')
  @ApiRoute({
    summary: 'Members and pending invitations of the active workspace',
    operationId: 'listMembers',
    response: { status: 200, schema: MembersOverviewSchema },
    errors: [401, 403],
  })
  list(@Ctx() auth: OrgAuth): Promise<MembersOverview> {
    return this.listMembers.execute(auth);
  }

  @Post('invitations')
  @RequirePermission('members:manage')
  @ApiRoute({
    summary: 'Invite someone by email',
    operationId: 'inviteMember',
    body: InviteMemberBody,
    response: { status: 201, schema: InvitationSchema },
    errors: [401, 403, 409],
  })
  invite(@Ctx() auth: AuthContext, @Body() body: InviteMemberBody): Promise<Invitation> {
    return this.inviteMember.execute(auth, body);
  }

  @Post('invitations/:invitationId/resend')
  @RequirePermission('members:manage')
  @ApiRoute({
    summary: 'Send an invitation again with a fresh expiry',
    operationId: 'resendInvitation',
    response: { status: 200, schema: InvitationSchema },
    errors: [401, 403, 404],
  })
  resend(@Ctx() auth: AuthContext, @Param('invitationId', uuid) id: string): Promise<Invitation> {
    return this.resendInvitation.execute(auth, id);
  }

  @Delete('invitations/:invitationId')
  @RequirePermission('members:manage')
  @ApiRoute({
    summary: 'Withdraw a pending invitation',
    operationId: 'revokeInvitation',
    response: { status: 204, schema: null },
    errors: [401, 403, 404],
  })
  revoke(@Ctx() auth: AuthContext, @Param('invitationId', uuid) id: string): Promise<void> {
    return this.revokeInvitation.execute(auth, id);
  }

  @Patch('members/:memberId')
  @RequirePermission('members:manage')
  @ApiRoute({
    summary: "Change a member's role",
    operationId: 'changeMemberRole',
    body: ChangeMemberRoleBody,
    response: { status: 200, schema: MemberSchema },
    errors: [401, 403, 404, 409],
  })
  change(
    @Ctx() auth: AuthContext,
    @Param('memberId', uuid) id: string,
    @Body() body: ChangeMemberRoleBody,
  ): Promise<Member> {
    return this.changeRole.execute(auth, id, body.role);
  }

  @Delete('members/:memberId')
  @RequirePermission('members:manage')
  @ApiRoute({
    summary: 'Remove a member from the workspace',
    operationId: 'removeMember',
    response: { status: 204, schema: null },
    errors: [401, 403, 404, 409],
  })
  remove(@Ctx() auth: AuthContext, @Param('memberId', uuid) id: string): Promise<void> {
    return this.removeMember.execute(auth, id);
  }

  @Post('members/transfer-ownership')
  @RequirePermission('members:manage')
  @ApiRoute({
    summary: 'Make another member owner; you become admin',
    operationId: 'transferOwnership',
    body: TransferOwnershipBody,
    response: { status: 204, schema: null },
    errors: [401, 403, 404, 409],
  })
  transfer(@Ctx() auth: AuthContext, @Body() body: TransferOwnershipBody): Promise<void> {
    return this.transferOwnership.execute(auth, body.memberId);
  }
}
