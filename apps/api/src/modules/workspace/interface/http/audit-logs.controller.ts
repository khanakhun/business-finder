import { type AuditLogPage, AuditLogPageSchema, AuditLogQuerySchema } from '@bf/contracts';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { ListAuditLogsQuery } from '../../application/audit-logs.query.ts';

class AuditLogQueryDto extends zodDto(AuditLogQuerySchema) {}

/** The workspace's append-only audit log (owners and admins). */
@ApiTags('workspace')
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly listAuditLogs: ListAuditLogsQuery) {}

  @Get()
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Audit log of the active workspace, newest first',
    operationId: 'listAuditLogs',
    query: AuditLogQueryDto,
    response: { status: 200, schema: AuditLogPageSchema },
    errors: [401, 403],
  })
  list(@Ctx() auth: AuthContext, @Query() query: AuditLogQueryDto): Promise<AuditLogPage> {
    return this.listAuditLogs.execute(auth, query);
  }
}
