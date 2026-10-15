import {
  applyDecorators,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UseInterceptors,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { mergeMap, type Observable } from 'rxjs';
import { AuditLogger } from '../../application/audit-logger.ts';

export interface AuditedOptions {
  readonly entityType?: string;
  /** Route parameter holding the entity id. */
  readonly entityIdParam?: string;
  /** Metadata from the handler's result (never secret values; sensitive keys are redacted anyway). */
  readonly metadata?: (result: unknown, req: Request) => Record<string, unknown>;
}

const AUDITED = Symbol('bf.audited');

/**
 * Records `action` in the audit log after the handler succeeds (Decorator/Interceptor). Use cases that change
 * data record inside their transaction instead (`AuditLogger.record`); this suits read-only or external actions.
 */
export const Audited = (action: string, options: AuditedOptions = {}) =>
  applyDecorators(SetMetadata(AUDITED, { action, ...options }), UseInterceptors(AuditInterceptor));

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditLogger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.get<(AuditedOptions & { action: string }) | undefined>(
      AUDITED,
      context.getHandler(),
    );
    if (!spec) return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      mergeMap(async (result: unknown) => {
        const entityId = spec.entityIdParam ? req.params[spec.entityIdParam] : undefined;
        await this.audit.record({
          action: spec.action,
          ...(spec.entityType ? { entityType: spec.entityType } : {}),
          ...(typeof entityId === 'string' ? { entityId } : {}),
          ...(spec.metadata ? { metadata: spec.metadata(result, req) } : {}),
        });
        return result;
      }),
    );
  }
}
