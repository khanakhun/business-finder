---
id: BF-047
title: Chat-based site editing (Lovable-style) — tool-using edit agent with proposals, diffs and safe apply
milestone: M3 Build
epic: site-platform
type: feature
priority: P1
size: L
depends_on: [BF-013, BF-035, BF-037, BF-040, BF-041]
blocks: []
areas: [api, web, ai]
---

# BF-047 — Chat-based site editing (Lovable-style): tool-using edit agent with proposals, diffs and safe apply

## Context
After generation, the fastest way to adjust a preview is to say what you want. Examples: "make the hero warmer and shorter", "add a menu page with our breakfast items", "translate everything to English", "use a calmer palette", "replace the second gallery photo with something more tropical" ([PRD FR-46](../PRD.md#65-website-platform--ai-generation)).

Because sites are documents with typed, invertible operations (BF-033), a chat agent can edit them **safely**:
- it proposes a change set of operations;
- the user sees a visual diff;
- applying creates a new immutable version (author `chat_edit`, BF-035) and never publishes ([security §6](../conventions/security.md#6-llm-and-prompt-injection)).

Facts discipline still applies: the agent cannot invent prices, testimonials or awards. New facts stated by the user become explicit **user-asserted facts** (BF-040 overlay) after confirmation. The blocks engine's copy tasks (BF-041) are reused for rewriting and translation.

## Goal
A chat panel in the editor (and on the site page) backed by a streaming, tool-using **edit agent**. The agent:
- understands the current selection (page, block, locale);
- reads the site and facts through tools;
- proposes validated operation sets with a human-readable summary and a visual diff;
- asks clarifying questions when needed;
- refuses unsafe requests with alternatives;
- applies changes as new versions with one click (undoable).

## Scope
**In scope**
- **Persistence**:
  - `site_chat_threads` (`id`, `organization_id`, `site_id`, `created_by`, `title`, timestamps).
  - `site_chat_messages` (`id`, `thread_id`, `role` user|assistant, `parts` jsonb (text, tool calls/results summaries, proposal refs), `context` jsonb (selected page/block/locale, base version), `cost_usd`, `created_at`).
  - `site_change_proposals`:
    - `id`, `thread_id`, `message_id`, `site_id`, `base_version_id`;
    - `operations` jsonb (BF-033 ops), `summary` (localized to the user's UI language), `diff` jsonb (structural diff from `@bf/site-schema/diff`), `validation` jsonb;
    - `facts_to_assert` jsonb;
    - `status` (`proposed|applied|discarded|superseded|failed`), `applied_version_id?`, timestamps.
- **Edit agent** (`site-edit-agent.v1`, smart tier, AI SDK tool calling with a step limit of 8 and a budget per message):
  - **Read tools**:
    - `get_site_outline()`: pages, blocks (id, type, variant, short text excerpts per locale), theme, nav, locales;
    - `get_block(pageId, blockId)`: full props;
    - `get_facts(kind?, search?)`: display facts with ids;
    - `get_catalog(blockType?)`;
    - `list_assets(role?)` (site library + candidates);
    - `suggest_images(role, query)` (BF-038 suggestions; no AI generation without an explicit user request).
  - **Action tools**:
    - `propose_operations(ops[], summary)`: **dry-run** apply on the base spec, then `validate` + strict facts + `lintCopy`. Returns issues to the model so it can fix and retry within the step budget. A valid result is stored as a proposal.
    - `ask_clarification(question, options[])`.
    - `propose_user_fact(kind, value, note)`: creates a *pending* fact assertion shown to the user for confirmation. It is never stored silently.
    - `rewrite_text(targets[], instruction)` and `translate(targets|locale, …)`: thin wrappers reusing BF-041 `site-copy` / `copy-shorten` tasks, returning text proposals with `factsUsed`.
  - **No** publish tool, network tool or direct database access. Generating AI images requires an explicit user request and BF-038 budget checks.
  - **System prompt rules**:
    - edit only through operations;
    - minimal changes scoped to the request and selection;
    - facts-only grounding;
    - refuse fabricated testimonials, awards or prices and offer honest alternatives;
    - write locale-native copy with FR typography;
    - keep design quality (premium, calm, consistent);
    - summarize changes in the user's UI language.
  - **Context**: the current selection from the editor (page, block, locale, viewport), the last N messages, the outline (compact), and the brief summary (positioning and design direction). No crawled untrusted text is included.
- **API** (permissions `sites:generate`; streaming per AI SDK UI conventions; verify the current `useChat`/transport and UI message stream APIs):
  - `POST /v1/sites/:id/chat` with `{ threadId?, message, context }`: streams assistant text, tool activity (summarized) and proposal data parts.
  - `GET /v1/sites/:id/chat/threads`, `GET /v1/sites/:id/chat/threads/:threadId`.
  - `POST /v1/sites/:id/proposals/:proposalId/apply` (optional `confirmFacts[]`):
    1. creates confirmed user facts first;
    2. re-validates against the **current** version (rebase like BF-037: re-apply ops; failures → `superseded` with an explanation);
    3. `ApplySpecOperations` → new version (`author_type = chat_edit`);
    4. returns the version and diff.
  - `POST /v1/sites/:id/proposals/:proposalId/discard`.
  - `POST /v1/sites/:id/translate { locale, scope: 'missing'|'all' }`: a convenience entry returning a proposal (used by the BF-037 locale settings).
- **UI** (`apps/web/src/features/site-chat/`):
  - Chat panel docked in the editor (toggle `⌘/Ctrl+K` then "Chat"), with its context chip ("Editing: Home › Hero (FR)") and suggested prompts by context (e.g. on a hero: "Make it shorter", "More premium tone", "Try a split layout").
  - Streaming messages with tool activity collapsed ("Read 3 blocks · Checked facts").
  - A **proposal card**: summary, list of changes (human-readable from the diff), validation status, facts-to-confirm checkboxes, and buttons **Preview** (canvas shows the proposed state, toggling between before and after), **Apply**, **Discard**, **Refine** (continue chatting).
  - After apply: version badge, "Undo" (rollback to the base version), "Publish" shortcut (normal BF-035 flow with permission).
  - Clarification questions rendered as option chips. Refusals explained kindly with alternatives.
  - Site page (outside the editor): the same panel with a preview iframe.
- **Evals** (`packages/ai/evals/site-edit/*.jsonl`, ≥ 40 instructions FR/EN over fixture specs), with automatic checks per case:
  - expected properties: a page exists, a text length is under a limit, a variant changed, a palette is warmer (hue shift), the locale is complete;
  - **minimality**: only targeted blocks changed;
  - no new unsupported facts;
  - a valid spec;
  - refusal cases (fake testimonials) correctly refused with an alternative.

  Targets: success ≥ 90%, minimality ≥ 95%, refusal accuracy 100%.

**Out of scope**
- Real-time multi-user chat, voice input, AI image editing (inpainting), publishing via chat.

## Requirements
### Functional
- Applying a proposal always creates exactly one new version; discarding changes nothing; undo restores the previous version.
- User-stated facts are stored only after explicit confirmation and are labelled user-asserted with author and time.
- Proposals whose base version is outdated are rebased or superseded, never applied blindly.
### Non-functional
- First token < 2 s; P50 proposal < 15 s; cost per message ≤ USD 0.05 on average (measured by evals).
- All chat content scoped to the organization; messages retained for 180 days (configurable) then purged.

## Design
```
apps/api/src/modules/sites/
├── domain/chat/{proposal.ts, proposal-policy.ts}
├── application/chat/{send-message.ts (agent loop + streaming), apply-proposal.ts, discard-proposal.ts,
│                     translate.ts}
├── infrastructure/chat/{edit-agent.ts, tools/*.ts, repositories/*}
└── interface/http/{site-chat.controller.ts}
packages/ai/prompts/site-edit-agent.v1.md
packages/ai/evals/site-edit/*
apps/web/src/features/site-chat/{chat-panel.tsx, proposal-card.tsx, context-chip.tsx, suggestions.ts,
                                 use-site-chat.ts}
```
- Patterns:
  - Tool-using agent with **propose → validate → confirm → apply** (human in the loop).
  - Command with inverse (operations).
  - Dry-run / Unit of Work (proposal validation).
  - Specification (proposal policy: allowed op types, size limits).
  - Strategy (rewrite/translate reuse BF-041 tasks).
- Proposal policy: maximum 40 operations per proposal; operations touching more than 50% of blocks require the explicit phrase from the user ("redo the whole site"), otherwise the agent asks for clarification.

## Implementation plan
1. Tables, repositories, proposal domain/policy; apply/discard with rebase and fact confirmation.
2. Agent tools (read/action) with dry-run validation; prompt v1; streaming endpoint (verify AI SDK APIs).
3. Translate/rewrite wrappers reusing BF-041 tasks.
4. Chat panel UI integrated into the editor with selection context, proposal preview (before/after toggle) and undo.
5. Evals (≥ 40 cases) and tuning; cost/latency measurement; retention job.

## Testing
- **Unit:** proposal policy (limits, minimality guard), rebase outcomes, fact confirmation flow, tool input validation.
- **Integration** (fake LLM with recorded tool-calling fixtures):
  - "shorten the hero" yields a valid proposal touching one block;
  - apply creates a version with `author_type chat_edit`;
  - outdated base gives superseded/rebased;
  - a request for fake testimonials is refused with no proposal created;
  - a user-stated price yields a pending fact, and apply with confirmation stores the fact and the version;
  - authorization (other org 404; viewer cannot apply).
- **E2E:** editor → chat "Ajoute une page Menu avec nos formules petit-déjeuner" (fixture facts with menu items) → proposal → preview → apply → canvas updated → undo.
- **Evals:** report attached (success, minimality, refusals, cost, latency).

## Acceptance criteria
- [x] Streaming chat with a tool-using edit agent grounded in the site, facts and catalog; selection-aware.
- [x] Proposals validated (schema, strict facts, copy lint) with a visual before/after preview; apply creates a version; undo works.
- [x] User-asserted facts only with explicit confirmation; refusals with alternatives for unsafe requests.
- [x] Translate/rewrite entry points used by the editor; rebase/supersede on outdated bases.
- [ ] Evals meet targets; cost and latency within budgets; retention configured.

## Agent prompt
```text
Implement BF-047 (Chat-based site editing).

Read first: AGENTS.md, docs/conventions/security.md §6 (LLM tools least privilege; chat edit never publishes),
docs/conventions/ai-engineering.md (§2–§6, §10), BF-033 (operations/diff/validators), BF-035 (versions/apply ops/
rollback), BF-037 (editor integration points, selection context, rebase), BF-040 (facts API, user-asserted overlay),
BF-041 (copy tasks to reuse).

Rules:
- The agent edits only through validated BF-033 operations proposed to the user; applying is a user action that
  creates a new version; nothing is ever published by the agent.
- Facts discipline: never invent; user-stated facts require explicit confirmation and are labelled user-asserted.
- Minimal, scoped changes; ask clarifying questions when the request is ambiguous or sweeping.
- Verify current AI SDK tool-calling and UI streaming APIs before coding; pin versions.
- Evals are part of the feature (≥ 40 FR/EN cases, minimality and refusal checks).

Verify: pnpm verify && pnpm test:int && pnpm e2e (site-chat); pnpm eval --filter=@bf/ai -- site-edit (attach report).
```

## References
- docs/conventions/security.md §6 · ADR-0009 · ADR-0011 · BF-033 · BF-035 · BF-037 · BF-040 · BF-041
- AI SDK tool calling: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling · AI SDK UI chatbot: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot
