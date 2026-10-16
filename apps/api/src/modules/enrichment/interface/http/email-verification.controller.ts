import type { ApiEnv } from '@bf/config';
import {
  ConflictError,
  type EnrichmentRun,
  EnrichmentRunSchema,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  type SmtpPortDiagnostic,
  SmtpPortDiagnosticSchema,
} from '@bf/contracts';
import { Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { APP_ENV, type AppEnv } from '../../../platform/config/app-env.ts';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { EnrichmentQueries } from '../../application/enrichment.use-cases.ts';
import { SMTP_PORT_PROBE, type SmtpPortProbe } from '../../application/ports.ts';
import { VerifyContactCommand } from '../../application/verify-contact.command.ts';

/** Seconds the port-25 diagnostic may take (DNS, then a TCP connect with its own 5 s timeout). */
const PROBE_TIMEOUT_MS = 10_000;

/** Routes guarantee an active workspace (`@RequirePermission`); without one the request is refused. */
function workspaceOf(auth: AuthContext): string {
  if (!auth.orgId) throw new ForbiddenError('An active workspace is required.');
  return auth.orgId;
}

/** E-mail verification (BF-028): on-demand checks and the SMTP port diagnostic. */
@ApiTags('enrichment')
@Controller()
export class EmailVerificationController {
  constructor(
    private readonly verifyContact: VerifyContactCommand,
    private readonly queries: EnrichmentQueries,
    @Inject(SMTP_PORT_PROBE) private readonly probe: SmtpPortProbe,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  @Post('contacts/:id/verify')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('business:write')
  @ApiRoute({
    summary:
      'Verify an e-mail contact now: starts an `email_verify` enrichment run for its business (or returns the ' +
      'run already open, 200). Addresses are checked at most once per TTL; fresh verdicts come from the cache.',
    operationId: 'verifyContact',
    response: { status: 201, schema: EnrichmentRunSchema },
    errors: [401, 403, 404, 409, 422, 429],
  })
  async verify(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) contactId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EnrichmentRun> {
    const organizationId = workspaceOf(auth);
    const outcome = await this.verifyContact.execute({ organizationId, userId: auth.userId, contactId });
    if (outcome.kind === 'rejected') {
      switch (outcome.reason) {
        case 'busy':
          throw new RateLimitedError('Too many enrichments are waiting in this workspace; try again later.');
        case 'not_found':
          throw new NotFoundError('Contact', contactId);
        // Manual runs are created even when nothing can run (the run says why); kept for exhaustiveness.
        case 'budget':
        case 'nothing_to_do':
          throw new ConflictError('E-mail verification cannot run now.', {
            details: { reason: outcome.reason },
          });
      }
    }
    res.status(outcome.kind === 'started' ? 201 : 200);
    return this.queries.run(organizationId, outcome.run.id);
  }

  @Post('workspace/diagnostics/smtp-port')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary:
      'Can this deployment reach mail servers on port 25? Opens a TCP connection to a large provider’s MX (no ' +
      'mail sent). Without it, Reacher cannot check mailboxes: use the commercial verifier.',
    operationId: 'diagnoseSmtpPort',
    response: { status: 200, schema: SmtpPortDiagnosticSchema },
    errors: [401, 403, 429],
  })
  async smtpPort(@Ctx() auth: AuthContext): Promise<SmtpPortDiagnostic> {
    workspaceOf(auth);
    const result = await this.probe.probe(AbortSignal.timeout(PROBE_TIMEOUT_MS));
    return { ...result, reacherConfigured: Boolean((this.env as ApiEnv).REACHER_URL) };
  }
}
