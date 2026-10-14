---
id: BF-011
title: Workspace settings, encrypted secrets vault and audit log
milestone: M1 Find & List
epic: identity
type: feature
priority: P0
size: M
depends_on: [BF-010]
blocks: [BF-013, BF-017, BF-018, BF-039, BF-049, BF-050, BF-055, BF-060]
areas: [api, web, security]
---

# BF-011 — Workspace settings, encrypted secrets vault and audit log

## Context
Several features need per-workspace configuration: the agency's identity and **postal address** (mandatory in outreach footers, see [compliance §2](../compliance/outreach-compliance.md#2-mandatory-message-elements-all-jurisdictions)), default languages and timezone, feature flags, and **provider credentials** (Google Places, Anthropic/OpenAI, PageSpeed, Foursquare/HF, Unsplash, …) that must be stored encrypted ([security.md §2](../conventions/security.md#2-secrets)). Security-relevant and outbound actions must be auditable.

## Goal
Owners/admins manage workspace identity, locales, timezone, feature flags and provider keys from the dashboard; keys are envelope-encrypted and never returned; every sensitive action lands in an append-only audit log viewable by owners/admins.

## Scope
**In scope**
- Tables (`packages/db/src/schema/workspace.ts`):
  - `org_settings` (PK `organization_id`): `agency_name`, `legal_name`, `postal_address` jsonb (`line1`, `line2?`, `city`, `postal_code`, `region?`, `country_code`), `website_url`, `logo_asset_key`, `primary_locale`, `locales` text[], `timezone`, `sender_defaults` jsonb (`fromName`, `signatureMarkdown`), `features` jsonb, `updated_by`, timestamps.
  - `secrets`: `id`, `organization_id`, `name` (registry key), `ciphertext` bytea, `iv` bytea, `auth_tag` bytea, `wrapped_dek` bytea, `dek_iv` bytea, `dek_tag` bytea, `key_version` int, `last4` text, `created_by`, `updated_at`, `last_used_at`; unique (`organization_id`, `name`).
  - `audit_logs`: `id`, `organization_id` (nullable for platform events), `actor_type` (`user|api_key|system`), `actor_id`, `action` (dotted, e.g. `secrets.updated`), `entity_type`, `entity_id`, `ip`, `user_agent`, `metadata` jsonb (no secrets), `occurred_at`; trigger preventing UPDATE/DELETE (append-only); index (`organization_id`, `occurred_at desc`).
- `@bf/contracts`: `OrgSettingsSchema`, `PostalAddressSchema`, `SecretName` registry (name, description, provider, `allowGlobalFallback`, optional `validatePattern`), `FeatureFlagsSchema` (`autoSend`, `codingEngines`, `mapsScraper`, `semanticSearch`, …), `AuditLogEntrySchema`.
- `workspace` module:
  - `SecretsVault` (application service) with `put`, `get` (JIT decrypt; in-memory cache ≤ 60 s; updates `last_used_at` asynchronously), `has`, `list` (metadata only), `delete`; AES-256-GCM per secret with random DEK; DEK wrapped by master key; AAD binds `orgId|name|keyVersion`; `MasterKeyProvider` port with `EnvMasterKeyProvider` (`SECRETS_MASTER_KEY` base64 32 bytes; supports `SECRETS_MASTER_KEY_PREVIOUS` for rotation) — KMS adapter can be added later.
  - `SecretResolver.resolve(orgId, name)` → workspace secret or (if `allowGlobalFallback`) env value; returns `{ value, source: 'workspace'|'global' }`; never logs values.
  - CLI `pnpm secrets:rotate-master` re-wraps all DEKs with the new master key (idempotent, resumable, audited).
  - `ConnectionTester` registry: features register `testConnection(orgId)` per secret name (implemented by provider tickets); API `POST /v1/workspace/secrets/:name/test`.
  - `FeatureFlagService.isEnabled(orgId, flag)`: env-level flag must be on **and** org flag on (org cannot enable infra-disabled features).
  - `AuditLogger.record(entry)` + `@Audited('action')` interceptor for controllers + helper for use cases; redaction of metadata keys matching secret patterns.
  - APIs: `GET/PATCH /v1/workspace/settings` (`settings:manage` for PATCH), `GET /v1/workspace/secrets` (metadata), `PUT /v1/workspace/secrets/:name`, `DELETE /v1/workspace/secrets/:name`, `GET /v1/audit-logs` (filters: action prefix, actor, entity, date range; cursor).
  - Logo upload: presigned S3 PUT (`POST /v1/workspace/logo/upload-url`) with content-type/size constraints; image re-encoded by a small job (sharp) — or validate on finalize.
- Web: `/settings/workspace` (identity + postal address form with country select incl. BL/MF, locales, timezone, logo upload), `/settings/integrations` (secrets list grouped by provider: status set/not set, source workspace/global, last used, replace/delete, Test button), `/settings/features` (flags with descriptions; env-disabled ones shown as unavailable), `/settings/audit` (table with filters).
- Outreach readiness check helper: `WorkspaceReadiness.forOutreach(orgId)` → missing items (postal address, agency name) — used by M4.

**Out of scope**
- Provider-specific connection tests (each provider ticket registers its tester). KMS integration (later). Data-subject tooling (→ BF-055).

## Requirements
### Functional
- Secret values are write-only from the API's perspective: responses contain only `last4`, timestamps, source.
- Rotating the master key keeps all secrets readable.
### Non-functional
- Decryption only in API/worker memory; values never in logs, traces, errors or audit metadata (tests assert).
- Audit log append-only at the DB level.

## Design
- Envelope encryption: `dek = randomBytes(32)`; `ciphertext = AES-256-GCM(dek, iv, plaintext, aad)`; `wrapped_dek = AES-256-GCM(masterKey[keyVersion], dek_iv, dek, aad)`.
- Patterns: Strategy (`MasterKeyProvider`), Registry (`SecretName`, `ConnectionTester`), Decorator/Interceptor (`@Audited`).

## Implementation plan
1. Contracts (settings, secret registry, flags, audit entry).
2. Crypto primitives + vault with unit tests (known-answer tests, tamper detection, AAD mismatch).
3. Tables + migration (+ append-only trigger) + repositories.
4. Use cases, APIs, interceptor, resolver, feature flags, readiness helper.
5. Rotation CLI with integration test.
6. Web settings pages (EN/FR).

## Testing
- Unit: encrypt/decrypt round trip; tamper (ciphertext, tag, AAD) → failure; rotation re-wrap; resolver precedence; flag combination truth table; audit metadata redaction.
- Integration: secrets API never returns values (snapshot of responses); viewer/member cannot PATCH settings (403); audit rows created for settings/secrets changes; UPDATE on `audit_logs` fails.
- E2E: set Google key in integrations page → status "set (workspace)" with last4; Test button shows result (fake tester in E2E).

## Acceptance criteria
- [ ] Workspace identity, postal address, locales, timezone, logo, feature flags editable by owner/admin.
- [ ] Secrets stored with envelope encryption; API never returns plaintext; rotation CLI works.
- [ ] `SecretResolver` workspace → global fallback per registry policy.
- [ ] Audit log append-only, populated for settings/secrets/member/API-key actions, viewable with filters.
- [ ] `WorkspaceReadiness.forOutreach` reports missing postal address/agency name.

## Agent prompt
```text
Implement BF-011 (Workspace settings, encrypted secrets vault and audit log).

Read first: AGENTS.md, docs/conventions/security.md §2 and §7, docs/compliance/outreach-compliance.md §2,
docs/ARCHITECTURE.md §5.1 (workspace module) and §13. Reuse BF-010 (RequestContext, permissions, members).

Rules:
- Use Node's crypto (AES-256-GCM) only; no custom crypto. Write known-answer and tamper tests first.
- Secret values must never appear in logs, traces, errors, audit metadata or API responses — add tests that
  search captured logs/responses for a sentinel secret value.
- The audit log must be append-only at the database level (trigger), not just by convention.

Verify: pnpm verify && pnpm test:int && pnpm e2e; demonstrate master-key rotation on a local DB in the PR.
```

## References
- docs/conventions/security.md §2 · docs/compliance/outreach-compliance.md §2 · docs/ARCHITECTURE.md §13
- NIST SP 800-38D (GCM) · Envelope encryption overview: https://cloud.google.com/kms/docs/envelope-encryption
