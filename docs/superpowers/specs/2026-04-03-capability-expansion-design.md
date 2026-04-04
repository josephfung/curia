# Capability Expansion: CEO Inbox & Web Search

**Date:** 2026-04-03
**Status:** Proposed

## Overview

Two new capabilities that unlock core EA work Nathan cannot currently do:

1. **CEO Inbox** — Nathan monitors and acts on Joseph's Gmail (joseph@josephfung.ca). Currently Nathan only has access to his own address (nathancuria1@gmail.com). Without inbox access, email triage, drafting replies on Joseph's behalf, and inbox filing are impossible.

2. **Web Search** — Nathan cannot look things up. This blocks simple queries ("find a restaurant near my meeting") and deep research tasks ("compare the geopolitical context of 1972 Apollo vs 2025 Artemis"). Web search is also a force-multiplier for inbox work — Nathan can research context before drafting a reply.

### What This Defers

- **Google Docs/Drive** — document storage, ongoing research files, expense receipt filing. Deferred until MCP support is implemented in the framework (spec 03). At that point, `@modelcontextprotocol/server-gdrive` is the likely approach.

### Design Principles Applied

- **Skills Must Add Value Beyond the Bare LLM** — skills are API bridges. No skill contains classification, summarization, or judgment logic. The LLM decides what to draft; the skill saves it to Drafts. The LLM decides what to search for; the skill fetches results.
- **Future-Proof for LLM Upgrades** — synthesis always stays in Nathan's LLM, never in a pre-synthesis API (Perplexity rejected for this reason). As Claude gets smarter, Nathan's research quality improves automatically at zero cost.
- **Phase-Gated Autonomy** — the CEO inbox integration is designed for three levels of autonomy. Only Phase 1 ships now. Phases 2 and 3 are config-flag additions, not architectural changes.

---

## Capability 1: CEO Inbox

### Autonomy Phases

The inbox integration supports three phases of autonomy, each a superset of the last:

| Phase | What Nathan does | Ships when |
|---|---|---|
| **1 — Monitor & Draft** | Reads inbox, drafts replies, saves to Joseph's Drafts folder. Daily digest notifies Joseph if drafts are pending. | Now |
| **2 — Archive & File** | Archives threads, applies Gmail labels. Builds on Joseph's existing filters. | Later |
| **3 — Autonomous Reply** | Replies as Joseph (or from nathancuria1@gmail.com) for threads Nathan can handle independently. | Later |

A `autonomy_phase` config field in `config/default.yaml` controls which behaviors are active.

### Architecture

**New Nylas grant:** Joseph's Gmail (joseph@josephfung.ca) connected to Nylas as a separate grant. Credential: `NYLAS_CEO_GRANT_ID`. The existing Nathan grant (`NYLAS_GRANT_ID`) is unchanged.

**New channel adapter:** `src/channels/email-ceo/`

- `email-ceo-adapter.ts` — polls Joseph's Nylas grant. Same polling pattern as `email-adapter.ts` (high-water timestamp, duplicate suppression). Publishes `inbound.message` with `channel_id: "email-ceo"`. Trust level: `high` (it is the CEO's own account).
- `nylas-ceo-client.ts` — thin wrapper around the Nylas SDK, parameterized by `NYLAS_CEO_GRANT_ID` and `NYLAS_CEO_EMAIL`. Mirrors `nylas-client.ts` in structure.
- Reuses `message-converter.ts`, `html-to-text.ts`, `markdown-to-html.ts` from `src/channels/email/` without modification.

**New skills (Phase 1):**

Skills are **account-aware** rather than account-specific — an optional `account: "nathan" | "joseph"` parameter determines which Nylas client is used. This mirrors the existing `email-send` pattern: `infrastructure: true`, credentials resolved by the handler via the injected Nylas client registry, never exposed to the LLM. One skill, two accounts, no parallel skill maintenance.

`email-list` — lists messages from any folder, for either account. The `folder` param maps to the Nylas `in` query parameter. Nylas uses `INBOX`, `DRAFTS`, `SENT`, and `TRASH` as standard folder IDs across providers. Additional filter params (`from`, `subject`, `searchQueryNative`) support triage queries like "find all emails from john@example.com about the Q1 report." This means `email-list(account: "joseph", folder: "DRAFTS")` also handles draft listing — no separate skill needed. Returns snippets (100 chars) per message, not full bodies — use `email-get` to read a specific message in full.
```json
{
  "name": "email-list",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "account": "string? (nathan | joseph, default nathan)",
    "folder": "string? (INBOX | DRAFTS | SENT | TRASH | <provider folder id>, default INBOX)",
    "limit": "number? (default 20)",
    "unreadOnly": "boolean? (default false)",
    "from": "string?",
    "subject": "string?",
    "searchQueryNative": "string? (Gmail/Outlook native query, e.g. 'from:john subject:Q1')"
  },
  "outputs": { "messages": "array of { id, threadId, subject, from, snippet, date, unread }" },
  "permissions": [],
  "secrets": []
}
```

`email-get` — fetches the full body and metadata of a single message by ID. **Required prerequisite for drafting** — `email-list` returns only 100-character snippets, which is not enough context to write a meaningful reply. Nathan calls `email-list` to find the message, then `email-get` to read it before drafting.
```json
{
  "name": "email-get",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "account": "string? (nathan | joseph, default nathan)",
    "messageId": "string"
  },
  "outputs": { "message": "object (id, threadId, subject, from, to, cc, body, date, unread, folders)" },
  "permissions": [],
  "secrets": []
}
```

`email-draft-save` — creates a draft via the Nylas drafts API (`nylas.drafts.create()`). This is a separate Nylas resource from messages — not a message saved to a folder. The name reflects what actually happens at the API level: a draft object is created, which appears in Gmail's Drafts folder.
```json
{
  "name": "email-draft-save",
  "sensitivity": "elevated",
  "infrastructure": true,
  "inputs": {
    "account": "string (nathan | joseph)",
    "to": "string",
    "subject": "string",
    "body": "string",
    "replyToMessageId": "string?"
  },
  "outputs": { "draftId": "string" },
  "permissions": [],
  "secrets": []
}
```

Elevated sensitivity ensures a human-approval gate the first time the coordinator uses this skill.

**Scheduler job (Phase 1):**

A recurring job at 5pm weekdays: Nathan calls `email-list(account: "joseph", folder: "DRAFTS")` and, if any drafts are present, sends a CLI notification summarising who they're addressed to and what they're about. Joseph can then open Gmail, review, and send or discard.

No new infrastructure. The job is created by Nathan via `scheduler-create` with a natural-language `task` string — the same way any recurring task is set up via chat. The scheduler fires it daily, the coordinator receives it as a normal prompt, and handles it with the skills it already has. The job persists in the Postgres-backed scheduler table across restarts.

This is set up during first-time onboarding via a CLI prompt like "keep an eye on my drafts and let me know at 5pm if there's anything waiting" — Nathan decides to create the job himself, exactly as if he'd been asked.

**New skills (Phase 2, not shipped now):**

- `email-archive` — removes a message from `INBOX` by updating its folders via `UpdateMessageRequest`. Supports `account` param.
- `email-label` — applies Gmail labels to a thread via `UpdateMessageRequest`. Supports `account` param.

**New skills / modifications (Phase 3, not shipped now):**

- `email-send` gains an `account` parameter. When `account: "joseph"`, routes through a new `email-ceo` OutboundGateway path that enforces `autonomyPhase ≥ 3`. Elevated sensitivity.
- `email-reply` gains an `account` parameter with the same gating.

### Outbound Gateway

All writes to Joseph's account (draft saves, eventual sends) route through `OutboundGateway`. Phase 1 only writes drafts — no sends. The gateway's blocked-contact and content-filter checks still apply to drafts to prevent Nathan from drafting problematic content.

A new autonomy gate is added to OutboundGateway for Phase 3: if `autonomyPhase < 3`, attempts by `email-send` with `account: "joseph"` are blocked and the coordinator is told to save a draft instead.

### Contact System

Participants extracted from Joseph's inbox threads are auto-created as `provisional` contacts with source `email_ceo_participant`. Same flow as the primary email adapter. This enriches the shared contact graph — a contact who has emailed both Nathan and Joseph is the same contact record.

### Persona Guidance

When Nathan is drafting a reply for Joseph's Drafts folder, he is writing *in Joseph's voice*, not his own. The coordinator prompt is updated to clarify:

- When acting on `email-ceo` threads, Nathan writes as Joseph — first person, Joseph's tone, no references to Nathan as a person
- When replying as himself (Phase 3, `channel_id: "email"`), Nathan writes as Nathan

### Configuration

```yaml
# config/default.yaml additions
channels:
  email-ceo:
    enabled: true
    pollingIntervalMs: 30000
    autonomyPhase: 1       # 1 = monitor+draft, 2 = +archive, 3 = +send

scheduler:
  jobs:
    - name: ceo-draft-digest
      schedule: "0 17 * * 1-5"   # 5pm weekdays
      task: check-ceo-drafts-and-notify
```

### Files to Create/Modify

| Action | Path |
|---|---|
| Create | `src/channels/email-ceo/email-ceo-adapter.ts` |
| Create | `src/channels/email-ceo/nylas-ceo-client.ts` |
| Create | `skills/email-list/skill.json` + `handler.ts` + `handler.test.ts` |
| Create | `skills/email-get/skill.json` + `handler.ts` + `handler.test.ts` |
| Create | `skills/email-draft-save/skill.json` + `handler.ts` + `handler.test.ts` |
| Modify | `config/default.yaml` — add `email-ceo` channel config and scheduler job |
| Modify | `agents/coordinator.yaml` — pin new skills, add persona guidance |
| Modify | `src/index.ts` (or channel bootstrap) — register `email-ceo-adapter` |
| Modify | `src/skills/outbound-gateway.ts` — autonomy phase gate (Phase 3 prep) |

---

## Capability 2: Web Search

### Approach

Two composable skills — Nathan calls them as many times as needed in the tool-use loop:

- `web-search` (new) — calls Tavily API, returns structured results per URL: title, URL, snippet, extracted content. Nathan issues multiple targeted queries for complex research.
- `web-fetch` (exists) — fetches full page content for a specific URL. Nathan uses this for articles identified as important in search results.

The LLM orchestrates all synthesis. No pre-synthesis API layer.

### Why Tavily

Tavily is purpose-built for AI agents. Unlike raw search APIs (Brave, SerpAPI), Tavily performs content extraction alongside the search — returning clean text from the page, not just a snippet. This is critical for the deep research use case where Nathan needs actual article content, not just headlines. The provider is swappable; it is just a skill.

### Search Depth

Tavily's `search_depth` parameter maps to the query's complexity:

- `"basic"` — fast, snippet-only. Suitable for "find me a ramen restaurant" queries.
- `"advanced"` — slower, full content extraction. Suitable for research tasks.

Nathan decides which to use based on the task. The skill exposes both via an input parameter.

### Skill Design

`skills/web-search/skill.json`:
```json
{
  "name": "web-search",
  "description": "Search the web using Tavily. Returns structured results with title, URL, snippet, and (for advanced depth) extracted page content. Call multiple times with refined queries for complex research tasks.",
  "sensitivity": "normal",
  "inputs": {
    "query": "string",
    "maxResults": "number? (default 5, max 20)",
    "searchDepth": "string? (basic | advanced, default basic)"
  },
  "outputs": {
    "results": "array of { title, url, snippet, content?, score }",
    "count": "number"
  },
  "permissions": ["network:search"],
  "secrets": ["tavily_api_key"],
  "timeout": 30000
}
```

`skills/web-search/handler.ts` — calls `https://api.tavily.com/search`, returns normalized results. Sanitizes returned content (HTML stripped, max 5KB per result) before it reaches the LLM.

### Coordinator Guidance

System prompt addition (paraphrased — written in Nathan's voice per persona rules):

> For simple lookups, one search is enough. For research tasks, run multiple targeted searches before forming a conclusion — each query should explore a different angle. When a search result looks important, use web-fetch to read the full article before summarizing it.

### Files to Create/Modify

| Action | Path |
|---|---|
| Create | `skills/web-search/skill.json` |
| Create | `skills/web-search/handler.ts` |
| Create | `skills/web-search/handler.test.ts` |
| Modify | `agents/coordinator.yaml` — pin `web-search`, add research guidance |
| Modify | `config/default.yaml` — add `TAVILY_API_KEY` secret reference |

---

## Implementation Sequence

**Ship web search first.** It is a smaller lift (one skill, no channel setup), and it immediately makes Nathan smarter for inbox triage — he can research context before drafting a reply. Inbox work starts in a better position with web search already available.

1. `feat/web-search` — `web-search` skill + coordinator pin
2. `feat/ceo-inbox` — `email-ceo` adapter + `email-list` / `email-get` / `email-draft-save` skills + scheduler job

---

## Verification

### Web Search
- Nathan answers "find me a ramen restaurant near King and Spadina" with real, specific results
- Nathan produces a structured synthesis with citations for a multi-angle research query
- `handler.test.ts` covers: valid query returns results, empty results, API error, missing API key, content sanitization

### CEO Inbox (Phase 1)
- Sending a test email to joseph@josephfung.ca causes it to appear in Nathan's context within one polling interval
- Nathan calls `email-get` on a thread message then drafts a reply → it appears in Joseph's Gmail Drafts folder, not in Sent
- No email is dispatched from Joseph's address in Phase 1 — OutboundGateway blocks it
- Scheduler job fires at 5pm and sends a CLI notification listing pending draft subjects
- Contact extracted from the test email thread appears as a provisional contact in the contact system
