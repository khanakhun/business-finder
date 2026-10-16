// Public surface of the workspace module (ARCHITECTURE.md §5.1): other modules import from here only.
export { type AuditActor, type AuditEntryInput, AuditLogger } from './application/audit-logger.ts';
export {
  type ConnectionTester,
  ConnectionTesterRegistry,
  type ConnectionTestResult,
} from './application/connection-testers.ts';
export { FeatureFlagService } from './application/feature-flags.service.ts';
export { type ResolvedSecret, SecretResolver } from './application/secret-resolver.ts';
export { SecretsVault } from './application/secrets-vault.ts';
export { WorkspaceDefaults } from './application/workspace-defaults.ts';
export { WorkspaceReadiness } from './application/workspace-readiness.ts';
export { Audited } from './interface/http/audited.interceptor.ts';
