# Outreach compliance — rules summary and system invariants

> **Not legal advice.** This page summarizes public sources to seed the policy engine. Every seeded policy ships with `needs_legal_review = true` and must be confirmed by a qualified person in the workspace's compliance settings before automatic sending is enabled for that jurisdiction. When in doubt, the system falls back to `manual_only`.

## 1. Seeded jurisdiction policies (B2B email)

| Code | Jurisdiction | B2B cold email regime (summary) | Generic vs personal addresses | Calls to businesses | Seed decision default |
|---|---|---|---|---|---|
| `US` | United States | Opt-out (CAN-SPAM): no prior consent; truthful headers and subject, identify as ad where applicable, valid physical postal address, working opt-out honoured within 10 business days. | Same rules. | Federal/state telemarketing rules mainly target consumers; B2B calls generally allowed (manual). | `allowed_with_conditions` |
| `FR` | France | Opt-out for professionals if the message relates to the recipient's profession, with information and an opt-out from the first message (CPCE L.34-5, CNIL guidance). | Generic addresses (contact@, info@) are not personal data, but e-commerce/LCEN rules still apply; personal professional addresses follow the opt-out regime above. | Allowed with right to object (B2B). | `allowed_with_conditions` (relevance check required) |
| `BL` | Saint-Barthélemy | Overseas collectivity of France (not part of the EU since 2012). Seeded to mirror `FR`; confirm locally applicable rules. | As `FR`. | As `FR`. | `allowed_with_conditions`, **needs legal review** |
| `MF` | Saint-Martin (French side) | Seeded to mirror `FR` (EU outermost region). | As `FR`. | As `FR`. | `allowed_with_conditions` |
| `NL` | Netherlands | Prior consent required, also for businesses (Telecommunicatiewet art. 11.7), except addresses the business **designated and published for receiving such messages**; an info@ on a contact page is not proof by itself. "Acquisitie wordt niet op prijs gesteld" removes the exception. | See regime. | Cold calls to legal persons (BV/NV) allowed with right to object; sole traders/vof/maatschap need consent. | `manual_only` |
| `BE` | Belgium | Prior consent required, except impersonal addresses of legal persons (info@, sales@) for offers aimed at legal persons. Personal addresses at company domains require consent. | See regime. | Separate rules. | `allowed_with_conditions` for impersonal addresses only; personal → `blocked` |
| `DE` | Germany | Prior express consent required for email advertising, including B2B (UWG §7). | — | B2B calls need at least presumed consent. | `blocked` (manual contact only) |
| `GB` | United Kingdom | Corporate subscribers (Ltd, LLP, PLC): no prior consent; must identify sender and offer opt-out. Sole traders/partnerships: consent required (PECR). | Corporate generic/personal at corporate domains: corporate rules. | Check TPS/CTPS. | `allowed_with_conditions` if legal person, else `manual_only` |
| `*` | Any other | Unknown. | — | — | `manual_only` |

GDPR-grade handling applies to **all** jurisdictions because the operator is EU-based: documented legitimate interest, information about the source at first contact, objection honoured immediately, data minimization, retention limits.

## 2. Mandatory message elements (all jurisdictions)

1. Real sender identity (person + agency name). No aliases/fantasy names.
2. Agency postal address (from workspace settings; sending is blocked if missing).
3. Clear, working opt-out: one-click link + `List-Unsubscribe` / `List-Unsubscribe-Post` headers (RFC 8058) + honouring plain "unsubscribe/stop/désinscription" replies.
4. Source disclosure: where we found the address ("We found your email on your website <domain>").
5. Relevance: the offer relates to the recipient's business (checked: offer ↔ business category mapping).
6. Language: recipient's language when known (FR for Saint-Barthélemy by default).
7. No misleading subject lines; no fake "Re:"/"Fwd:" prefixes on first touch.

## 3. System invariants (enforced in code and tests)

| Invariant | Where |
|---|---|
| No outbound message reaches `queued` without a persisted `allowed*` decision | `outreach` domain + architecture test |
| Decision re-evaluated at send time (suppression may have changed) | send processor |
| Unknown jurisdiction ⇒ `manual_only` | `compliance` policy resolver |
| Workspace overrides can only make policies stricter | policy merge function + tests |
| Suppression checked at enqueue and send; unsubscribe applies to all mailboxes and sequences immediately | `compliance` + `outreach` |
| "No solicitation" markers on the website (FR: *pas de démarchage/prospection*, NL: *acquisitie wordt niet op prijs gesteld*, EN: *no solicitation*) ⇒ email blocked for that business | enrichment signal → compliance |
| Every message stores: decision id, policy version, lawful-basis record id, footer version | `outbound_messages` |
| Prospect data purged after configurable inactivity (default 36 months) | retention job |

## 4. Sources (for the reviewer)

- ACM — spam rules (NL): https://www.acm.nl/nl/onderwerpen/telecommunicatie/internet/spam
- Overloop — Dutch/Belgian cold-acquisition law overview (Sep 2026): https://overloop.com/nl/blog/koude-acquisitie-wetgeving
- CNIL — règles de la prospection par courrier électronique: https://www.cnil.fr/fr/les-regles-dor-de-la-prospection-par-courrier-electronique-0
- Legiscope — RGPD, prospection email B2B (summary): https://www.legiscope.com/blog/rgpd-marketing-email-sms.html
- FTC — CAN-SPAM Act compliance guide: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- ICO — PECR electronic mail marketing: https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/
- RFC 8058 — one-click unsubscribe: https://www.rfc-editor.org/rfc/rfc8058
