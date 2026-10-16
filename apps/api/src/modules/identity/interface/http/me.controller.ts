import { type Me, MeSchema } from '@bf/contracts';
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, NoOrgRequired } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { GetMeQuery } from '../../application/get-me.query.ts';

@ApiTags('identity')
@Controller('me')
export class MeController {
  constructor(private readonly getMe: GetMeQuery) {}

  @Get()
  @NoOrgRequired()
  @ApiRoute({
    summary: 'The signed-in user, their workspaces, role and permissions',
    operationId: 'getMe',
    response: { status: 200, schema: MeSchema },
    errors: [401, 403],
  })
  me(@Ctx() auth: AuthContext): Promise<Me> {
    return this.getMe.execute(auth);
  }
}
