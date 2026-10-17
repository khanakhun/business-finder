---
id: BF-055
title: Unsubscribe (RFC 8058) and suppression management, data-subject requests, retention jobs, data map
milestone: M4 Reach
epic: compliance
type: feature
priority: P0
size: L
depends_on: [BF-011, BF-012, BF-048, BF-049]
blocks: [BF-052]
areas: [api, web, compliance, db]
---

# BF-055 — Unsubscribe (RFC 8058) and suppression management, data-subject requests, retention jobs, data map

## Context
An outreach system must make it effortless to stop receiving messages. It must also answer "what data do you have about me?" and "delete it", and keep data only as long as needed ([PRD FR-56](../PRD.md#66-outreach), [ADR-0012](../adr/0012-compliance-by-design-outreach.md), [security §7](../conventions/security.md#7-logging--privacy)). Requirements:
- **RFC 8058** one-click unsubscribe (`List-Unsubscribe-Post`) is expected by major mailbox providers.
- CAN-SPAM requires a working opt-out for at least 30 days after sending.
- GDPR-grade handling requires honouring objection immediately, answering access and erasure requests within one month, and enforcing retention limits.

BF-049 provides the suppression core (append-only log, lookup, `contact.suppressed` event) and decisions. BF-048 captures site opt-outs. This ticket adds the **unsubscribe token service and public endpoints** that BF-052 needs before any real email can be sent, a **suppression management UI**, a **DSR framework** used by every module that stores personal data, and the **retention engine**.

## Goal
- Opaque, long-lived unsubscribe tokens with RFC 8058-compliant one-click POST and a localized confirmation page. The page is safe against link scanners and offers preview removal.
- Suppression list management (search, add, import, export, revoke with reason).
- A pluggable DSR framework (access, erasure, objection, rectification, restriction) with deadlines and audit.
- A retention policy registry with a daily job and dry-run reports.
- A documented data map (records of processing).

## Scope
**In scope**
- **Unsubscribe tokens**:
  - `unsubscribe_tokens`: `id` (random 128-bit, base64url, the URL path), `organization_id`, `contact_id?`, `email_encrypted` (envelope-encrypted; needed to suppress), `email_hash` (sha256 + pepper, for lookups), `business_id?`, `outbound_message_id?`, `locale`, `created_at`, `expires_at` (default 2 years; ≥ 30 days is required), `used_at?`.
  - `UnsubscribeTokenService.issue({ orgId, contactId|email, messageId?, locale }) → { token, httpsUrl, mailtoUrl? }`. Used by BF-052 (fail-closed if issuance fails).
  - Unsubscribe base URL: `UNSUBSCRIBE_BASE_URL` (e.g. `https://u.<main-domain>` routed by Caddy to the API public routes). Sending domains and this host must be HTTPS with a valid certificate.
- **Public endpoints** (no auth or cookies; rate-limited; responses never reveal other data):
  - `POST /v1/public/unsubscribe/:token` (**RFC 8058 one-click**):
    - accepts `List-Unsubscribe=One-Click` (form-encoded or multipart), suppresses immediately (scope email; `source = one_click`) and returns `200` with no redirect;
    - idempotent;
    - an unknown or expired token returns `200` with a generic body (do not leak), and is logged.
  - `GET /u/:token` (human page, served by the API's public web view or a minimal page in `apps/sites`):
    - **does not unsubscribe on GET** (link scanners prefetch);
    - shows the agency identity, what will happen, and a **Confirm** button (POST);
    - options:
      - "Unsubscribe this address" (default);
      - "Stop all contact with my business" (adds an `org_business` suppression + `do_not_contact`);
      - "Remove the preview website made for my business" (if a preview exists; reuses BF-048 opt-out behaviour: unpublish);
    - localized FR/EN by token locale, with a language switch;
    - works without JavaScript.
  - `POST /u/:token`: form submission → suppress per the chosen options → confirmation page ("You won't receive further messages from {agency}").
  - Optional `mailto:` unsubscribe (`unsubscribe+{token}@{domain}`), processed by BF-054 if enabled (feature flag; off by default).
- **Suppression effects** (BF-049 `suppress()` emits `contact.suppressed`; consumers must be idempotent):
  - cancel queued and pending-approval messages for the address/business (BF-052 subscriber);
  - stop enrollments (BF-053 subscriber);
  - add an activity entry;
  - notify the owner (digest, not per event).
- **Suppression management UI** (`/compliance/suppressions`; `compliance:manage` to revoke, `outreach:send` to view/add):
  - Search by email/domain/phone/business; filters (reason, source, scope, date).
  - Add a manual entry (with reason).
  - **Import CSV**: preview, validation, normalization, dedupe, scope; large files processed as a job.
  - **Export CSV** (audited).
  - **Revoke** (owner only; requires a reason; append-only revoke entry; warns if the original reason was an unsubscribe: revoking an unsubscribe requires documented new consent).
  - Global suppressions (platform-level, `organization_id = null`) are visible read-only to workspaces.
- **DSR framework** (`compliance` module):
  - `PersonalDataProvider` interface registered by each module:
    ```ts
    interface PersonalDataProvider {
      readonly id: string;                      // 'crm.contacts', 'sites.leads', 'outreach.outbound', …
      readonly categories: string[];            // 'contact_details', 'message_content', …
      find(subject: DataSubjectQuery): Promise<PersonalDataRecordRef[]>;   // email | phone | name+business
      export(refs: PersonalDataRecordRef[]): Promise<ExportChunk[]>;
      erase(refs: PersonalDataRecordRef[], mode: 'delete' | 'anonymize'): Promise<ErasureResult>;
      restrict?(refs: PersonalDataRecordRef[], on: boolean): Promise<void>;
    }
    ```
  - Providers implemented in this ticket for existing modules:
    - business contacts (BF-024/BF-028);
    - notes and tasks mentioning the identifier (search; manual review list);
    - site leads (BF-048);
    - suppressions and decisions (export only; decisions are retained as legal proof with minimal data);
    - site chat messages (BF-047) when they contain the identifier;
    - view analytics (none: aggregates only).

    BF-052 and BF-054 register their outbound and inbound providers.
  - `dsr_requests`: `id`, `organization_id`, `type` (`access|erasure|objection|rectification|restriction`), `subject` (encrypted identifiers), `status` (`received|verifying|in_progress|completed|rejected`), `received_at`, `due_at` (+1 month, configurable), `verification` jsonb (method, notes), `actions` jsonb (log), `export_key?` (encrypted zip in private storage with an expiring signed link), `handled_by`, timestamps.
  - **Workflow**:
    1. Create a request (admin UI, or the public "exercise your rights" form on the BF-048 privacy page: rate-limited, creates `received`).
    2. Verification step (manual: the confirmation method is recorded).
    3. Discovery across providers (results grouped by provider).
    4. Execute:
       - **access**: export ZIP with JSON + CSV + README;
       - **erasure**: delete or anonymize per provider. **Objection/erasure keeps a hashed suppression entry** (sha256 + pepper) so we never contact the person again without storing their address in clear;
       - **objection**: suppression + do-not-contact;
       - **rectification**: guided edit;
       - **restriction**: flag that blocks processing.
    5. Completion with an audit entry.

    Deadline reminders at 7 days and 2 days.
- **Retention engine**:
  - `RetentionPolicy` registry (each module registers `{ id, table/entity, condition, action: delete|anonymize|truncate_payload, batchSize }`), run by the `system.retention` daily job.
  - Dry-run mode (counts only) and a report (`retention_runs` table: per policy counts, duration, errors).
  - Admin page showing policies, last runs and upcoming deletions.
  - Default policies (configurable per workspace within platform bounds):
    | Data | Retention |
    |---|---|
    | Prospect personal contacts inactive for 36 months | named persons' contact details and notes anonymized; business-level public info kept |
    | Inbound message bodies | 24 months (raw MIME 90 days) |
    | Outbound message bodies | 24 months (decision records kept 3 years with minimal fields) |
    | Leads | 24 months (spam 30 days) |
    | Site chat messages | 180 days |
    | Generation events | 90 days |
    | Provider source payloads | per licensing TTL (BF-016 enforcement verified here) |
    | Unsubscribe tokens | 2 years after creation |
    | Audit logs | 3 years |
    | Suppressions | never deleted (converted to hashed form after 3 years of inactivity) |
- **Data map** (`docs/compliance/data-map.md`): personal data categories, purposes, legal bases (LIA reference), sources, recipients and processors (hosting, Google, Microsoft, Anthropic, OpenAI, stock/image providers, email verification), international transfers, retention, security measures. Linked from the privacy page template (BF-048) and the compliance settings.
- **Permissions**: `compliance:manage` (owner) for DSR execution, revocations and retention settings; admins can create DSR requests and view suppressions.

**Out of scope**
- Sending pipeline (→ BF-052), inbound processing (→ BF-054), legal review of texts (a human task; templates flagged `needs_legal_review`).

## Requirements
### Functional
- One-click POST suppresses within 1 s and affects all mailboxes, sequences and queued messages of the workspace (event-driven; verified end to end).
- GET never unsubscribes (scanner-safe); confirmation works without JavaScript.
- Erasure leaves no clear-text identifier in the database except where legally retained (decisions minimal fields), verified by a post-erasure search across providers; future contact is still prevented via the hashed suppression.
### Non-functional
- Public endpoints rate-limited and constant-time token lookups (no timing oracle); tokens are unguessable (128-bit).
- Retention jobs are batched (≤ 1,000 rows per transaction), resumable and observable.

## Design
```
apps/api/src/modules/compliance/
├── domain/{unsubscribe-token.ts, dsr-request.ts, dsr-state-machine.ts, retention-policy.ts}
├── application/{unsubscribe/{issue-token.ts, one-click.ts, confirm.ts}, suppressions/{import.ts, export.ts},
│                dsr/{create.ts, discover.ts, execute.ts, reminders.ts}, retention/{run.ts, report.ts}}
├── infrastructure/{providers-registry.ts, dsr-providers/*.ts, retention-policies/*.ts, export/zip-builder.ts,
│                   processors/{retention.processor.ts, dsr-reminder.processor.ts, suppression-import.processor.ts}}
└── interface/http/{public-unsubscribe.controller.ts, unsubscribe-page.controller.ts (SSR minimal HTML),
                    suppressions-admin.controller.ts, dsr.controller.ts, retention.controller.ts}
apps/web/src/features/compliance/{suppressions/*, dsr/*, retention/*}
docs/compliance/data-map.md
```
- Patterns:
  - Registry/Plugin (DSR providers, retention policies).
  - State Machine (DSR request).
  - Append-only log (suppressions).
  - Batch processing with checkpoints.
  - Fail-closed token issuance.

## Implementation plan
1. Token service (issue/lookup, encryption, hashing) + one-click endpoint + confirmation page (FR/EN, no-JS) + Caddy route for the unsubscribe host.
2. Suppression effects verification (subscribers exist in BF-052/BF-053; add contract tests here using events).
3. Suppression management UI (search, add, import job, export, revoke).
4. DSR framework + providers for existing modules + workflow UI + reminders + public intake.
5. Retention registry, default policies, job, dry-run reports, admin page.
6. Data map document; docs updates in compliance pages.

## Testing
- **Unit:** token generation and encoding; RFC 8058 request parsing (form and multipart); DSR state machine; retention condition builders; CSV import normalization.
- **Integration:**
  - one-click POST suppresses; a repeat is idempotent;
  - an unknown token gets a generic 200;
  - GET does not suppress;
  - confirm with "stop all contact" sets do-not-contact;
  - "remove preview" unpublishes (BF-035);
  - DSR access export contains data from all registered providers;
  - erasure anonymizes and keeps a hashed suppression, and a later evaluate (BF-049) blocks the same email;
  - retention dry-run counts equal actual deletions on fixtures;
  - authorization for revoke and DSR execution.
- **E2E:** click the footer link (Mailpit message) → confirmation page FR → confirm → status shown in the suppression list; admin runs an access DSR and downloads the ZIP.
- **Security:** timing test on token lookup (no measurable difference between valid and invalid tokens beyond noise); rate limits.

## Acceptance criteria
- [x] Unsubscribe token service (fail-closed) + RFC 8058 one-click endpoint + scanner-safe localized confirmation page with preview-removal option.
- [x] Suppression management (search, add, import, export, revoke with reason) with immediate cross-mailbox effects.
- [x] DSR framework with providers for existing modules, workflow, deadlines and audited exports and erasure; hashed suppression after erasure.
- [x] Retention registry, default policies, daily job with dry-run and reports.
- [x] `docs/compliance/data-map.md` written and linked.

## Agent prompt
```text
Implement BF-055 (Unsubscribe, suppression management, DSR and retention).

Read first: AGENTS.md (§8), docs/adr/0012, docs/compliance/outreach-compliance.md, docs/conventions/security.md
(§2 secrets, §7 privacy), BF-049 (suppression core, decisions), BF-048 (opt-out, privacy page, unpublish), BF-011
(vault/encryption, audit). Skim BF-052, BF-053 and BF-054 (consumers of tokens and suppression events; they register
DSR providers).

Rules:
- RFC 8058: one-click POST without auth/cookies/redirects; GET never unsubscribes.
- Fail closed: if a token cannot be issued, sending must not happen (BF-052 depends on this).
- Erasure must not prevent honouring objection: keep hashed suppressions.
- Every DSR and revocation action is audited; deadlines tracked.
- Retention is data-driven (registry), batched, resumable and reportable.

Verify: pnpm verify && pnpm test:int && pnpm e2e (unsubscribe + DSR).
```

## References
- ADR-0012 · docs/compliance/outreach-compliance.md · docs/conventions/security.md §7
- RFC 8058: https://www.rfc-editor.org/rfc/rfc8058 · RFC 2369 (List-Unsubscribe): https://www.rfc-editor.org/rfc/rfc2369 · FTC CAN-SPAM guide: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business · GDPR Art. 12–21 (rights, timelines): https://eur-lex.europa.eu/eli/reg/2016/679/oj · CNIL — rights requests: https://www.cnil.fr/fr/professionnels-comment-repondre-une-demande-de-droit-dacces
