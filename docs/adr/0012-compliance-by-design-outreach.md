# ADR-0012: Compliance-by-design outreach with a mandatory policy gate

- Status: Accepted
- Date: 2026-10-14
- Tickets: BF-049…BF-057

## Context

Unsolicited commercial email rules differ by country and recipient type. Examples (summarized, not legal advice): the US is opt-out (CAN-SPAM); France and Saint-Barthélemy (which generally follows French rules) allow B2B email without prior consent if the message relates to the recipient's profession and offers an opt-out; the Netherlands requires prior consent for businesses too unless the address was published for that purpose; Germany requires consent; Belgium allows impersonal addresses of legal persons. Calls have separate rules. The operator is EU-based, so GDPR-grade data handling applies regardless of where recipients are. Mistakes risk fines and sending-domain reputation.

## Decision

- A **`compliance` module** owns jurisdiction policies, suppression lists, compliance decisions and lawful-basis records.
- **Mandatory gate**: `ComplianceService.evaluate(target, channel, context)` is called (1) when a message is queued and (2) again immediately before the provider send. The outbound pipeline cannot transition a message to `queued` without a persisted `allowed`/`allowed_with_conditions` decision. There is no other send path (enforced by module boundaries and an architecture test).
- **Decision inputs**: recipient jurisdiction (from business location; contact domain as secondary signal), recipient type (legal person vs sole trader when known), address type (generic `info@` vs personal), address publication context (e.g. published on the business's own contact page), message purpose relevance (offer category vs business category), suppression (email/domain/business/global), "no solicitation" markers detected on the website, contact verification status, workspace policy overrides (stricter only).
- **Outputs**: `allowed` | `allowed_with_conditions` (e.g. must include source disclosure, must use generic address) | `manual_only` | `blocked`, with machine-readable reasons and required message elements (identity, postal address, opt-out link, source line).
- **Conservative defaults**: unknown jurisdiction ⇒ `manual_only`; seeded policies carry `needs_legal_review: true` until a human confirms them in the UI; workspaces can only make policies stricter.
- **Message invariants**: real sender identity (no aliases), agency postal address, working one-click unsubscribe (RFC 8058), source disclosure ("we found your address on your website …"), language matching the recipient.
- **Data handling**: legitimate-interest assessment record per campaign; retention policy (default purge after 36 months of inactivity); data-subject request tooling; suppression is append-only and checked at enqueue and send.

## Alternatives considered

| Option | Why not |
|---|---|
| UI warnings only | Easy to bypass by accident (bulk actions, automation, scripts). |
| Hard-coded country rules in send code | Untestable, unreviewable by non-developers, can't be updated without deploys. |
| Rely on the sending provider | Providers enforce deliverability, not jurisdiction law. |

## Consequences

- Positive: every send is explainable after the fact (stored decision + inputs).
- Positive: legal review can happen in the UI without code changes.
- Negative: some sends will be blocked conservatively; the UI must explain why and offer compliant alternatives (call, manual email, letter).

## References

- docs/compliance/outreach-compliance.md (rules summary and sources)
- RFC 8058 (one-click unsubscribe)
