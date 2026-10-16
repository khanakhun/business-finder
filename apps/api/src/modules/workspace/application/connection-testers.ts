import { ConflictError, NotFoundError, type SecretName } from '@bf/contracts';
import { Injectable } from '@nestjs/common';
import { SecretResolver } from './secret-resolver.ts';

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly message?: string;
}

/** Checks a credential against its provider. Implemented by provider tickets (BF-018, BF-028, …). */
export type ConnectionTester = (input: {
  readonly organizationId: string;
  readonly value: string;
  readonly signal: AbortSignal;
}) => Promise<ConnectionTestResult>;

export const CONNECTION_TEST_TIMEOUT_MS = 10_000;
const MAX_MESSAGE = 200;

/** Registry: features register a tester per secret name; the API runs it on demand. */
@Injectable()
export class ConnectionTesterRegistry {
  private readonly testers = new Map<SecretName, ConnectionTester>();

  constructor(private readonly resolver: SecretResolver) {}

  register(name: SecretName, tester: ConnectionTester): void {
    if (this.testers.has(name)) throw new Error(`A connection tester for ${name} is already registered`);
    this.testers.set(name, tester);
  }

  has(name: SecretName): boolean {
    return this.testers.has(name);
  }

  async test(
    organizationId: string,
    name: SecretName,
  ): Promise<ConnectionTestResult & { readonly source: 'workspace' | 'global' }> {
    const tester = this.testers.get(name);
    if (!tester) throw new NotFoundError('ConnectionTester', name);
    const secret = await this.resolver.resolve(organizationId, name);
    if (!secret) {
      throw new ConflictError(`No ${name} key is set.`, { details: { reason: 'SECRET_NOT_SET' } });
    }
    let result: ConnectionTestResult;
    try {
      result = await tester({
        organizationId,
        value: secret.value,
        signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS),
      });
    } catch {
      // Provider errors may quote the request (and so the key): report a generic failure.
      result = { ok: false, message: 'The connection test failed.' };
    }
    return { ...sanitize(result, secret.value), source: secret.source };
  }
}

/** Testers' messages are shown to users: strip the secret if a provider echoed it, and bound the length. */
function sanitize(result: ConnectionTestResult, value: string): ConnectionTestResult {
  if (result.message === undefined) return { ok: result.ok };
  const message = result.message.split(value).join('[REDACTED]').slice(0, MAX_MESSAGE);
  return { ok: result.ok, message };
}
