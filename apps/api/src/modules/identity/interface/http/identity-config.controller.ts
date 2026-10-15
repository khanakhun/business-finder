import { MIN_PASSWORD_LENGTH } from '@bf/auth';
import type { ApiEnv } from '@bf/config';
import { type IdentityConfig, IdentityConfigSchema } from '@bf/contracts';
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { APP_ENV, type AppEnv } from '../../../platform/config/app-env.ts';
import { AllowAnonymous } from '../../../platform/security/auth.decorators.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { signupModeOf } from '../../infrastructure/better-auth.provider.ts';

/** Public: lets the sign-in/sign-up pages show only what is enabled (no secrets, no user data). */
@ApiTags('identity')
@Controller('identity')
export class IdentityConfigController {
  private readonly config: IdentityConfig;

  constructor(@Inject(APP_ENV) appEnv: AppEnv) {
    const env = appEnv as ApiEnv;
    this.config = {
      signupMode: signupModeOf(env),
      googleEnabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      minPasswordLength: MIN_PASSWORD_LENGTH,
    };
  }

  @Get('config')
  @AllowAnonymous()
  @ApiRoute({
    summary: 'Which sign-in and sign-up options are enabled',
    operationId: 'getIdentityConfig',
    response: { status: 200, schema: IdentityConfigSchema },
  })
  get(): IdentityConfig {
    return this.config;
  }
}
