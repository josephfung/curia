# Identifier provenance (#2061) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An identifier an agent enters (`contact-register` → `agent_called`, `contact-create` / `contact-link-identity` → `agent_stated`) is verified only when the server finds it in text the model did not write.

**Architecture:** The agent runtime keeps a process-wide index of identifiers seen in source-tool results, keyed by the root conversation. A delegated task uses the conversation it came from. Each tool invocation gets an `identifierSources` lookup, which checks that index and the person-authored `user` turns of the root conversation in working memory. The contact handlers consult it and set `verified` explicitly. `agent_called` and `agent_stated` leave `AUTO_VERIFIED_SOURCES`.

**Tech Stack:** TypeScript (ESM), Vitest, Postgres working memory, `libphonenumber-js`.

**Spec:** GitHub issue #2061 (body), as amended in conversation on 2026-10-08:
- `contact-register` checks against mailbox tool results already fetched in the conversation (`ceo-inbox-list` / `-search` / `-read` are source tools). It does not do a separate Nylas read, and it takes no `message_id`.
- Source-tool results count across the whole conversation. A delegated task counts toward its origin conversation.

## Global Constraints

- **Verification.** `agent_called` and `agent_stated` are never auto-verified. Writers pass `verified` explicitly.
- **contact-register never fails because of provenance.** A miss registers the identity unverified.
- **contact-create / contact-link-identity refuse on a miss and store nothing.** The duplicate check still runs first, so its messages take precedence.
- **Refusals never echo the identifier** (ADR-047).
- **Approval replays.** A `humanApproved` re-invoke counts as a source: the principal saw the identifier in the approval.
- **Source tools.** Only tools whose manifest sets `"provenance_source": true` count. The field defaults to false. `delegate` and `bullpen` must never set it.
- **Person turns.** These are `role = 'user'`, `archived = false`, `synthetic = false`, `channel_id` not null, and `channel_id` not one of `internal`, `bullpen`, `scheduler`. The `[ACTIVE OUTBOUND CONTEXT]` preamble is stripped before matching.
- **Changelog.** Each bullet is at most 15 words after the em-dash. The `tool.json` schema change is called out as public API.

## Review Focus

1. **Phone in another format:** a principal writes `416-555-0100` and the agent stores `+14165550100`. It should match. Task 1 tests it.
2. **Address with trailing punctuation:** "email sam@venue-co.com." should match `sam@venue-co.com`. Task 1 tests it.
3. **Delegated specialist:** a specialist creates a contact from its brief while the address was in the principal's message. It should be verified. Task 3 tests it.
4. **Restart or TTL expiry:** the index is lost. The agent is refused and asks again; it never verifies silently. Task 2 tests expiry.
5. **Memory read fails:** the lookup returns false and logs a warning, and the write is refused or stored unverified. It never throws into the handler. Task 3 tests it.

---

### Task 1: Pure identifier extraction

**Files:**
- Create: `src/contacts/identifier-provenance.ts`
- Test: `tests/unit/contacts/identifier-provenance.test.ts`

**Interfaces (produces):**
```ts
export interface IdentifierSources { has(channel: string, identifier: string): Promise<boolean>; }
export function sourceKeyFor(channel: string, identifier: string): string;   // 'email:x' | 'phone:+1…' | 'token:x'
export function sourceKeysInText(text: string): Set<string>;
```

- [ ] Write tests:
  - an email in prose, JSON, angle brackets and `mailto:`, and with trailing punctuation;
  - email matching ignores case;
  - phones `416-555-0100`, `(416) 555-0100`, `+1 416 555 0100`, `+44 20 7946 0958`, a fictional 555 number;
  - a Slack id token `U012AB3CD`;
  - a near-miss email is absent.
- [ ] Run `pnpm -C <wt> vitest run tests/unit/contacts/identifier-provenance.test.ts` and confirm it fails.
- [ ] Implement:
  - **email** — `/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi`, lowercased.
  - **phone** — runs matching `/\+?\d[\d\s().-]{5,}\d/g`. A run starting with `+` becomes `+digits`. Ten digits become `+1` plus the digits. Eleven digits starting with 1 become `+` plus the digits. Also add `normalizePhone(run)` when it is non-null.
  - **token** — `/[A-Za-z0-9@_][A-Za-z0-9_.@+-]{2,63}/g`, with trailing `.`/`-` trimmed.
  - **`sourceKeyFor`** — email is lowercased; a phone channel goes through `normalizeAgentIdentifier(channel, id)`; anything else becomes `token:` plus the id.
- [ ] Run the tests and confirm they pass. Commit.

### Task 2: Source index

**Files:**
- Create: `src/agents/identifier-source-index.ts`
- Test: `tests/unit/agents/identifier-source-index.test.ts`

**Interfaces (produces):**
```ts
export class IdentifierSourceIndex {
  constructor(options?: { ttlMs?: number; maxKeysPerConversation?: number; maxConversations?: number; now?: () => number });
  record(conversationKey: string, text: string): void;
  has(conversationKey: string, key: string): boolean;
}
export const sharedIdentifierSourceIndex: IdentifierSourceIndex;
```

- [ ] Write tests for:
  - recording then finding a key;
  - another conversation not seeing it;
  - expiry after the TTL, using an injected clock;
  - the per-conversation cap dropping the oldest keys;
  - the conversation cap evicting the least recently touched conversation.
- [ ] Implement it as a `Map<conversationKey, Map<key, addedAt>>`. Re-touching a conversation moves it to the end. The defaults are a 24 h TTL, 20 000 keys and 1 000 conversations.
- [ ] Run the tests and confirm they pass. Commit.

### Task 3: Plumbing (manifest field, working memory, execution, runtime)

**Files:**
- Modify: `src/skills/types.ts`, adding the `ToolManifest.provenance_source?: boolean` and `ToolContext.identifierSources?: IdentifierSources` fields.
- Modify: `schemas/tool-manifest.schema.json`, adding the `provenance_source` boolean.
- Modify: `src/skills/execution.ts`, adding `InvokeOptions.identifierSources`, forwarding it to ctx, and adding `isProvenanceSource(toolName): boolean`.
- Modify: `src/startup/test-mode-stack.ts`, adding `isProvenanceSource` to `EXECUTION_LAYER_METHODS`.
- Modify: `src/memory/working-memory.ts`, adding `getPersonTurns(conversationId, agentId): Promise<string[]>` on both backends, plus the `NON_PERSON_CHANNELS` export.
- Modify: `src/agents/delegated-task-context.ts`, adding `delegationOriginAgentId`.
- Modify: `src/agents/runtime.ts`, adding the config field `identifierSourceIndex?`. It builds `identifierSources` per task, records source-tool results after success, and passes the lookup in `invokeOptions`.
- Tests: `tests/unit/memory/working-memory-person-turns.test.ts`, `tests/unit/agents/runtime-identifier-sources.test.ts`, `tests/unit/skills/execution.test.ts`, and an integration test for the Postgres `getPersonTurns`.

- [ ] **Runtime test.** The LLM calls `web-fetch`, then `contact-create`. The fake execution layer has `isProvenanceSource: (n) => n === 'web-fetch'`, and `web-fetch` returns `'Book: events@venue.example'`. Assert that the second invoke's `options.identifierSources.has('email', 'events@venue.example')` resolves true and `has('email', 'event@venue.example')` false.
- [ ] **Delegated runtime test.** The origin conversation's coordinator turn on channel `cli` says "email sam@venue-co.com". A delegated task has `delegationOrigin {conversationId, agentId:'coordinator'}`. `has` should resolve true. A turn on channel `internal` alone should resolve false.
- [ ] **Memory failure test.** `getPersonTurns` throws. `has` resolves false and the failure is logged.
- [ ] **Working memory test.** Only person turns are returned: synthetic, `internal`, `bullpen`, `scheduler`, assistant and archived turns are excluded.
- [ ] **Execution test.** `identifierSources` reaches `ctx`, and `isProvenanceSource` reads the manifest.
- [ ] Implement:
  - Root conversation = `delegationOriginConversationId(md) ?? conversationId`.
  - Person scope = the delegation origin's `(conversationId, agentId)` for a delegated task, otherwise `(conversationId, agentId)`.
  - Record with `index.record(root, resultContent)` just before the success `return { content }`.
- [ ] Run typecheck and the touched tests. Commit.

### Task 4: Handlers and manifests

**Files:**
- Create: `src/skills/_shared/identifier-source.ts`, with `identifierHasSource(ctx, channel, identifier): Promise<boolean>` (true when humanApproved) and `unsourcedIdentifierError(channel, consequence): string`.
- Modify: `skills/contacts/tools/contact-register/{handler.ts,tool.json,handler.test.ts}`. The skill lowercases email, verifies when sourced, verifies an unverified `agent_called` identity in place, and returns `verified`. The manifest moves to 1.3.0.
- Modify: `skills/contacts/tools/contact-create/{handler.ts,tool.json,handler.test.ts}`. After the duplicate check, an unsourced identifier is refused, and `verified: true` is passed explicitly. The manifest gets a patch bump.
- Modify: `skills/contacts/tools/contact-link-identity/{handler.ts,tool.json,handler.test.ts}`. The new-link and `outbound_recipient` re-statement paths require a source. The manifest gets a patch bump.
- Modify: `src/contacts/contact-service.ts` (`AUTO_VERIFIED_SOURCES` and its comment) and `src/contacts/types.ts` (the `agent_called` comment).
- Modify these manifests to set `"provenance_source": true` with a patch bump: `web-fetch`, `web-browser`, `web-search`, `doc-read`, `doc-search`, `email-get`, `email-get-thread`, `email-list`, `file-parse`, `ceo-inbox-list`, `ceo-inbox-search`, `ceo-inbox-read`.
- Modify: `skills/contacts/SKILL.md`, removing `contact-register` from the bundle.
- Test: `tests/unit/skills/provenance-source-manifests.test.ts`. It checks the exact flagged set, that `delegate` and `bullpen` are unflagged, that the contacts bundle omits `contact-register`, and that ceo-inbox pins it.

contact-register handler cases:
- a clean new sender with a source: verified;
- an exact existing contact: resolved, no new identity;
- a near miss with no source: unverified, success;
- no `identifierSources`: unverified, success;
- a later sourced call: verified in place;
- humanApproved: verified.

contact-create cases:
- a stated address: verified;
- no source: refused, with no contact created and no echo of the address;
- a taken address: the taken message still wins;
- humanApproved: verified.

contact-link-identity cases:
- a new link with no source: refused;
- an `outbound_recipient` re-statement with no source: refused, still unverified;
- a re-statement with a source: verified.

- [ ] Write the tests, confirm they fail, implement, confirm they pass, run typecheck, and commit.

### Task 5: Docs and changelog

- [ ] **ADR-047.** Update the "Agent-entered addresses" section, the `agent_called` paragraph at "Gateway-created contacts" and the "No principal-specific similarity rule" bullets to record the provenance rule, the source tools, `humanApproved`, and the `file-parse` LLM-extraction caveat.
- [ ] **Spec 09.** Add an `agent_called` row and update the `agent_stated` row and line 124.
- [ ] **Docs for the new field.** Document `provenance_source` in `docs/dev/adding-a-tool.md` and `docs/specs/03-tools-and-execution.md`.
- [ ] **CHANGELOG [Unreleased].** Add Security, Changed and the public API bullets.
- [ ] Run the full unit suite with `pnpm -C <wt> test:unit` (or equivalent), plus lint and typecheck. Commit.
- [ ] **Issue #2061.** Update the body to match the amended decisions.
