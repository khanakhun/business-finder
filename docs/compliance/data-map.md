# Data map: records of processing (BF-055)

> **Not legal advice.** This is a starting point for the workspace's records of processing (GDPR art. 30). Have it
> reviewed by a lawyer, and complete it with each workspace's own details (controller identity, DPO, processors'
> contracts) before relying on it. `needs_legal_review`.

Business Finder is used by an agency (the **workspace**, the controller) to find local businesses, build preview
websites for them and contact them. The platform operator hosts it (a processor for each workspace).

Everything below names the module that stores the data, the DSR provider that finds, exports and erases it
(`PersonalDataRegistry`), and the retention policy that ends it (`RetentionRegistry`). Both registries can be read at
**Compliance → Data requests / Retention**.

## 1. Categories of people

| Who | Examples |
|---|---|
| **Prospects** | Owners and staff of the local businesses found (names, business emails and phones published on their sites or in directories). |
| **Leads** | People who use a preview site's forms: claims, contact requests, opt-outs and data requests. |
| **Workspace members** | The agency's users: accounts, sessions, audit trail, connected mailboxes. |

## 2. Records

| Data | Categories | Purpose | Legal basis | Source | Stored in (module) | DSR provider | Retention |
|---|---|---|---|---|---|---|---|
| Business contact points (email, phone, person's name) | contact details, names | Find and qualify prospects; outreach | Legitimate interest (approved LIA, Settings → Compliance → Lawful basis) | Public websites, directories, provider APIs (Google Places, Foursquare, OpenStreetMap, open data) | `business_contacts` (business graph) | `business_graph.contacts` | Contacts of businesses inactive 36 months anonymized (follow-up policy) |
| Provider source payloads | business data, sometimes names | Entity resolution | Legitimate interest; provider licences | Provider APIs | `business_sources` | — (business data) | Per provider licensing TTL (BF-016) |
| CRM notes and tasks | free text | Follow-up of prospects | Legitimate interest | Workspace members | `notes`, `tasks` (CRM) | `crm.notes_and_tasks` (manual review) | With the business record |
| Preview leads | names, emails, phones, WhatsApp, messages, consent | Answer the person; claims and opt-outs | Consent (forms); legal obligation (opt-outs) | The person | `site_leads` (leads) | `sites.leads` | 24 months; spam 30 days (`sites.leads`) |
| Site chat messages | message content (may quote contacts) | Editing preview sites with the AI agent | Legitimate interest | Workspace members | `site_chat_messages` (site chat) | `sites.chat_messages` | 180 days after the last activity (`sites.chat_threads`) |
| Suppressions | emails, domains, phones, business ids, keyed hashes | Never contact people who refused | Legal obligation | Unsubscribes, opt-outs, replies, imports | `suppression_entries`, `suppressions_current` (compliance) | `compliance.suppressions` | Never deleted; clear text replaced by a keyed hash after erasure (hashing after 3 years of inactivity: follow-up) |
| Unsubscribe tokens | email (encrypted), keyed hash | One-click and page unsubscribe | Legal obligation | Issued per message | `unsubscribe_tokens` (compliance) | `compliance.unsubscribe_tokens` | 2 years (`compliance.unsubscribe_tokens`) |
| Compliance decisions | evaluation inputs (no address), reasons | Proof of the gate's decision for each message | Legal obligation / accountability | The gate | `compliance_decisions` (compliance) | — (no identifier) | 3 years (follow-up policy) |
| Data-subject requests | identifiers (encrypted), trail | Answer rights requests | Legal obligation | The person or the team | `dsr_requests` (compliance) | — | Exports deleted 30 days after completion (`compliance.dsr_exports`) |
| Outbound email | recipient address, subject and body | Outreach | Legitimate interest | Members (drafts, one-click send) | `outbound_messages`, `email_threads` (outreach) | `outreach.outbound` (erasure anonymizes; the row and its decisions stay) | Address and content anonymized after 24 months (`outreach.outbound`) |
| Manual contact logs | free-text summaries of calls, messages, visits | Record of contacts made by hand | Legitimate interest | Members | `manual_contact_logs` (outreach) | `outreach.manual-logs` (manual review) | Summaries anonymized after 24 months (`outreach.manual-logs`) |
| Inbound email | addresses, message bodies | Replies | Legitimate interest | Mailboxes | BF-054 tables | Registered by BF-054 | Bodies 24 months, raw MIME 90 days (BF-054) |
| Mailbox credentials | OAuth tokens, app passwords | Sending from the members' mailboxes | Contract (with the member) | The member | Vault (`secrets`, sealed) | — | Purged at disconnection |
| Members and audit log | names, emails, IP-free audit entries | Accounts, security, accountability | Contract; legitimate interest | Members | `users`, `audit_logs` | — | Audit 3 years (follow-up policy) |

Page views of preview sites are **aggregates only**: no IP address or user agent is stored (a daily-salted network
hash for rate limits, then counts).

## 3. Recipients and processors

| Processor | What it receives | Where |
|---|---|---|
| Hosting provider (application servers, Postgres, Valkey, S3-compatible storage) | Everything stored | The deployment's region |
| Google (Places API, PageSpeed, Gmail API when a Gmail mailbox is connected) | Search areas and queries; site URLs; outgoing messages and replies of that mailbox | United States (SCCs / EU–US Data Privacy Framework) |
| Microsoft (Graph, when a Microsoft 365 mailbox is connected) | Outgoing messages and replies of that mailbox | Per the tenant's region |
| Anthropic, OpenAI (LLM tasks, coding agents) | Business public data, website text, briefs; never mailbox content in system prompts | United States (SCCs / DPF) |
| Email verification (ZeroBounce, when SMTP probing is blocked) | Email addresses being verified | United States (SCCs) |
| Stock images (Unsplash, Pexels) | Search keywords only | — |
| SMTP/IMAP provider of a connected mailbox | That mailbox's messages | Per provider |

## 4. International transfers

Transfers outside the EEA rely on the processors' Standard Contractual Clauses or the EU–US Data Privacy Framework.
Saint-Barthélemy and Saint-Martin are French overseas collectivities: Saint-Martin is part of the EU, while
Saint-Barthélemy is outside the EU but applies French data-protection law. Confirm the arrangement for each workspace.

## 5. Security measures

- Secrets and credentials are envelope-encrypted per workspace (master key outside the database). Unsubscribe
  addresses, DSR subjects and DSR exports are sealed with the same envelope encryption.
- Access is role-based (owner, admin, member, viewer). Every org-scoped query filters by the authenticated
  workspace. Sensitive actions are recorded in the append-only audit log.
- Erased people stay suppressed through a keyed hash (`PRIVACY_HASH_PEPPER`), so their address is not kept in
  clear text.
- Crawled content is treated as untrusted (never in system prompts). Coding agents run in an isolated sandbox with no
  database access.
- Logs carry no secrets or message content. Unsubscribe tokens and outreach references are redacted at the edge
  proxy.

## 6. Rights

People exercise their rights from the preview's privacy page ("Exercise your rights"), by replying to a message, or
by contacting the agency. Every request has a one-month deadline, a recorded verification and an audited trail
(**Compliance → Data requests**). An unsubscribe takes effect immediately, through RFC 8058 one-click or the
unsubscribe page.
