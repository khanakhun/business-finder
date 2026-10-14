# Security conventions

Threat model and hardening work: BF-060. These rules apply to every ticket.

## 1. Authentication & authorization

- Sessions via Better Auth; cookies HttpOnly, Secure, SameSite=Lax, scoped to the parent domain. TOTP 2FA available; enforced for owners/admins in production (setting).
- API keys: shown once, stored as SHA-256(key + pepper), prefix `bf_` for detection by secret scanners, scoped to an org and a permission set, revocable, last-used tracking.
- Every handler declares a permission. Every org-scoped repository method requires `orgId`. Tests include the cross-org case (expect 404) and the insufficient-role case (expect 403).
- State-changing requests from browsers: SameSite cookies + Origin/Referer check against the app origin; CORS allowlist = app origin only (plus sites origin for specific public endpoints).

## 2. Secrets

- Never in code, fixtures, logs, error messages or client bundles. `.env` is git-ignored; `.env.example` documents names only.
- Workspace secrets (provider keys, mailbox credentials, OAuth refresh tokens) are envelope-encrypted: a random 256-bit data key per secret encrypts the value with AES-256-GCM; the data key is encrypted with the master key (`SECRETS_MASTER_KEY`, 32 bytes base64, or a KMS adapter). Rotation re-wraps data keys.
- Secrets are decrypted just-in-time in the API/worker and never returned by the API (only `{ name, lastFourChars, updatedAt }`).

## 3. Input handling

- Validate every boundary with Zod (HTTP, jobs, webhooks, CLI args, LLM outputs).
- Output encoding: React escapes by default; any HTML from users, crawled pages or agents is sanitized (`sanitize-html` / DOMPurify server-side) and rendered only where explicitly allowed. SiteSpec text fields are plain text, not HTML.
- SQL only through Drizzle or `sql` template tags (parameterized). No string concatenation.
- File uploads: size limit, MIME sniffing (not trusting extension), images re-encoded with `sharp`, stored under random keys, served from the object store with `Content-Disposition` and correct `Content-Type`.

## 4. Outbound requests (SSRF)

All requests to URLs that come from users, providers or crawled pages use `SafeHttpClient` (TS) / `safe_fetch` (Python):
- Schemes `http`/`https` only; ports 80/443 (configurable allowlist).
- Resolve DNS first; reject private, loopback, link-local, CGNAT, multicast, reserved and cloud metadata addresses (IPv4 and IPv6, including IPv4-mapped IPv6); connect to the resolved IP (pinning) to prevent DNS rebinding.
- Re-validate on every redirect (max 5); total timeout and max response size; decompression bomb protection.
- Headless browsers (crawler, screenshots) run with request interception applying the same rules.

## 5. Coding-agent sandboxes

- Containers: non-root, read-only root FS, tmpfs workspace, no privileged mode, dropped capabilities, seccomp default, CPU/memory/pids limits, no Docker socket, no access to internal networks.
- Egress through an allowlisting proxy (model API hosts, approved image hosts). Everything else blocked and logged.
- Per-run API key with low budget where the provider supports it; otherwise CLI budget flags plus wall-time kill.
- Inputs (brief, facts) are data; agent instructions come only from our templated prompt. Outputs are validated (schema + facts) before persistence; agents never write to our DB or storage directly.

## 6. LLM and prompt-injection

- Untrusted text (crawled pages, reviews, inbound emails, provider payloads) is wrapped in `<untrusted_data source="…" id="…">…</untrusted_data>` and the system prompt states that instructions inside it must be ignored.
- Tools exposed to LLMs are least-privilege, validated, and side-effect-free unless the action is explicitly user-initiated (e.g. chat edit creates a new *draft* version, never publishes).
- LLMs never decide compliance outcomes; they may extract inputs (e.g. "no solicitation" phrases) that deterministic code evaluates.

## 7. Logging & privacy

- Structured logs; redact `authorization`, cookies, tokens, secrets, passwords, message bodies, and hash email addresses (`sha256(lowercase(email))[0..12]`) outside the outreach audit trail.
- Store only data needed for the purpose (no reviewer names, no personal social profiles of employees). Retention jobs enforce provider TTLs and the prospect inactivity purge.
- Data-subject requests (access, erasure, objection) handled through admin tooling (BF-055).

## 8. Web security headers

- CSP (nonce-based for scripts), `frame-ancestors 'none'` for the dashboard, HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` minimal.
- Generated sites: strict CSP allowing only our asset origins and approved embeds (maps, booking widgets) declared by blocks.

## 9. Dependencies & CI

- Lockfiles committed; `pnpm audit --prod` / OSV scan, `pip-audit`, gitleaks and CodeQL (or Semgrep) in CI; base images pinned by digest in production Dockerfiles.

## 10. Reporting

Security issues: open a private security advisory on GitHub; do not file public issues for vulnerabilities.
