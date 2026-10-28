# Agenda-Driven Calls, Transcript, Minutes and Structuring: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A principal voice call can be driven by parked agendas, which the shim can load at the start of the call or mid-call. When the call ends, it deterministically produces a transcript, minutes and exactly one coordinator structuring task that reports back to the principal.

**Architecture:**
- **Agendas** are OKF documents under `/meetings/agendas/`. They have a `pending → in_call → done | pending` lifecycle, implemented by an `AgendaStore` over `WorkingDocsRepo`.
- **Voice** gets agendas at session start from `SignalCallBridge`, and mid-call through a new voice tool. Loaded agendas render into every turn's system prompt.
- **On `voice.session.ended`,** a fire-and-forget system pipeline runs four steps: transcript doc, minutes doc (standard-tier `InfraLlm`), agenda settlement, then `minutes.ready`.
- **A second subscriber** turns `minutes.ready` into one coordinator task, which carries a lazy playbook skill and a system originator.
- **A startup sweep** recovers sessions a crash interrupted.

**Tech Stack:** TypeScript (ESM, Node 24), PostgreSQL via `pg`, Vitest, pino, luxon.

**Spec:** GitHub issue #2322 (the decisions D1–D7 in its body are binding), refining `docs/wip/2026-10-26-agenda-minutes-voice-shim-design.md` (#2316). Where they disagree, the issue wins, and **this plan wins over the issue where it records a correction** (see *Corrections to the issue* below).

## Global Constraints

- **No migration.** Everything fits existing tables (`working_documents`, `voice_sessions.metadata` JSONB, `tasks`, `scheduled_jobs`). If a step seems to need one, stop and ask the maintainer.
- **Code conventions:** ESM with `.js` import suffixes, no `any`, pino logging, no empty `catch`, parameterized SQL only (repo `CLAUDE.md`).
- **Typecheck:** `pnpm -C <worktree> run typecheck` before every commit that touches `.ts`.
- **Commits:** sign off with `-s` (DCO). Add no AI co-author trailer.
- **New tools:**
  - start at `"version": "0.1.0"`;
  - must declare `action_risk`;
  - inputs use the string notation of existing manifests (e.g. `skills/async-offramp/tool.json`).
- **Coordinator prompt budget is unchanged.** Nothing new is pinned to the coordinator, and `tests/unit/agents/prompt-budget.test.ts` must pass with no budget edits.
- **No paid behavior suites** (`pnpm smoke`, `pnpm scenarios`). Unit and integration tests only.
- **OKF paths:**
  - agendas: `/meetings/agendas/<agendaId>.md`
  - minutes: `/meetings/minutes/<YYYY-MM-DD>-<sessionId>.md`, dated by session start in the principal's timezone
  - transcripts: `/scratch/meeting-<sessionId>/transcript.md`
- **Limits** (each one, unless marked, resolves an item the issue's *Left to the implementation plan* section left open; that list is complete):

  | Item | Value |
  |---|---|
  | Agenda expiry | 7 days by default, 30 days maximum (from the issue) |
  | Preload "due" window | ±12 hours of `scheduled_for` (from the issue) |
  | Agenda context cap | 6,000 characters |
  | Title / topic / role caps | 120 / 200 / 500 characters |
  | Topics per agenda | 1–10 |
  | Transcript `ttl_days` | 14 (from the issue) |
  | Recovery sweep lookback | 7 days |

- **Names:**

  | Kind | Name |
  |---|---|
  | Parking tool | `meeting-agenda-park` (in a new, unpinned `meetings` bundle) |
  | Voice tool | `meeting-agenda-load` (standalone, voice-only) |
  | Playbook skill | `meeting-minutes-structuring` (zero-tool) |
  | Events | `minutes.ready`, `minutes.pipeline_failed` (both system-only) |
  | Structuring-task dedupe tag | `meeting-minutes:<sessionId>` |

- **Failed turn writes** (an item the issue left open): **not recorded in this slice.** The transcript frontmatter states that turns are persisted best-effort, and that their timestamps are persistence time, not speech time.
- **CHANGELOG** bullets are at most 15 words after the em-dash.

## Corrections to the issue

These came up while mapping the issue onto the code. Implement the plan's version.

1. **Mid-call agendas live in the system prompt, not only in a tool result.** Voice history (`ActiveSession.history`) keeps only spoken user and assistant text, so a tool result is gone by the next turn. The system prompt is rebuilt every turn (`buildTurnSystemPrompt`, `voice-runtime.ts:1280`), so every agenda loaded this session renders there. The block goes after the static prefix, just before the time block, so the cacheable prefix stays stable. `meeting-agenda-load`'s tool result only confirms the load.
2. **`meeting-agenda-park` is not pinned.** The coordinator's `localToolDefinitionBytes` budget has zero slack. The tool lives in the `meetings` bundle, which the coordinator activates on demand, following the `reports` bundle precedent (`agents/coordinator.yaml:166-168`).
3. **The structuring task is created without `wakeAt`,** then given its skill, then woken with `SchedulerService.enqueueTaskWake`. With `wakeAt` set, the 30-second scheduler poll can fire the task before `setActiveSkillsBlock` runs.
4. **The dedupe tag is `meeting-minutes:<sessionId>`,** not `voice-minutes:<sessionId>`, to match the `/meetings/` naming.
5. **Transcript rows** include only `role = 'user'` rows with `synthetic = false`, and `role = 'assistant'` rows. That excludes the `[Conversation summary]` system rows, any other system rows and the synthetic greeting cue. Do not filter on `archived`.

## Review Focus

These are the failure modes most likely to hurt the principal. Each has a pinning test in the task named.

1. **The principal edits an agenda in the console during a call,** so the version moves. Settlement re-reads and retries, and never throws or leaves the agenda stuck. *(Task 2: `settle retries after a version conflict`.)*
2. **The minutes LLM returns no parseable coverage,** or names unknown topics. Every loaded agenda goes back to `pending`, and the minutes are still saved. *(Task 9: `missing coverage block returns every agenda to pending`.)*
3. **The call goes free-form after an agenda loads.** The caller speaks, but on other things. Minutes are written, every topic is `not_reached`, and the agenda goes back to `pending` with a history entry. *(Task 10: `hijacked call returns the agenda with history`.)*
4. **The process dies between locking an agenda and writing minutes.** The startup sweep finishes the session, or returns an orphaned `in_call` agenda to `pending`. *(Task 12: `orphaned in_call agenda is released`.)*
5. **A non-principal or console caller.** No agendas are offered or locked, and the prompt is byte-identical to today's. *(Task 6: `non-principal caller gets no agendas`.)*

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/memory/durable-doc-prefixes.ts` (new) | `DURABLE_DOC_PREFIXES` and `isDurableDocPath`, the list #2338 will extend with `/shared/` |
| `src/meetings/types.ts` (new) | Agenda, snapshot, coverage and session-agenda types |
| `src/meetings/agenda-validation.ts` (new) | `validateParkAgendaInput`, `isDue` |
| `src/meetings/agenda-store.ts` (new) | Agenda document lifecycle over `WorkingDocsRepo` |
| `src/meetings/session-agendas.ts` (new) | `prepareSessionAgendas`: what a principal call starts with |
| `src/meetings/agenda-prompt.ts` (new) | `formatAgendaPromptBlock`, `parseAgendaLoadResult` |
| `src/meetings/transcript.ts` (new) | Pure transcript-doc builder |
| `src/meetings/minutes-writer.ts` (new) | Prompt, LLM call and output parsing for minutes |
| `src/meetings/minutes-pipeline.ts` (new) | Session-end orchestration: idempotent, publishes events |
| `src/meetings/subscribers.ts` (new) | `MeetingSessionEndedSubscriber`, `MinutesReadySubscriber` |
| `src/meetings/recovery.ts` (new) | `MeetingPipelineRecovery.sweep()` |
| `skills/meetings/SKILL.md` + `tools/meeting-agenda-park/` (new) | Agenda parking tool and authoring guidance |
| `skills/meeting-agenda-load/` (new) | Voice-only agenda load tool |
| `skills/meeting-minutes-structuring/SKILL.md` (new) | Zero-tool structuring playbook |
| `src/channels/voice/voice-runtime.ts` | `StartVoiceSessionParams.agendas`, session agenda state, the prompt part, result intercept |
| `src/channels/voice/voice-tools.ts` | Add `meeting-agenda-load` to `VOICE_TOOL_NAMES` |
| `src/channels/voice/session-store.ts` | `appendAgendaLoad`, `listRecentWithAgendas` |
| `src/channels/voice/signal/signal-call-bridge.ts` | Optional `agendaStore` dependency; prepares agendas for principal calls |
| `src/memory/working-memory.ts` | `getTranscriptRows` on the backend and the public API |
| `src/bus/events.ts`, `src/bus/permissions.ts` | `minutes.ready`, `minutes.pipeline_failed` |
| `skills/documents/tools/doc-write/handler.ts`, `src/db/working-docs-repo.ts` | Durable-prefix exemptions |
| `config/registry-defaults.yaml` | Enable both bundles and the standalone tool |
| `src/index.ts` | Wiring |

---

### Task 1: Durable `/meetings/` prefix

**Files:**
- Create: `src/memory/durable-doc-prefixes.ts`
- Modify: `skills/documents/tools/doc-write/handler.ts:34-58` (`resolveAssociatedRootTaskId`), `src/db/working-docs-repo.ts:619-635` (`archiveProjectWorkspaceDocs`)
- Test: `tests/unit/memory/durable-doc-prefixes.test.ts`, `skills/documents/tools/doc-write/handler.test.ts`, `tests/integration/working-docs-durable-prefix.test.ts`

**Interfaces:**
- Produces:
  - `export const DURABLE_DOC_PREFIXES: readonly string[] = ['/meetings/']`
  - `export function isDurableDocPath(path: string): boolean`, which normalizes with `normalizeDocPath` (`src/memory/okf.ts:85`) first.

- [ ] **Step 1: Write the failing tests**
  - `isDurableDocPath`:
    - `'/meetings/agendas/a.md'` → true;
    - `'meetings/minutes/x.md'` → true (normalized);
    - `'/projects/x/brief.md'` → false;
    - `'/meetingsx/a.md'` → false.
  - doc-write handler: a create at `/meetings/agendas/a.md` with `taskMetadata.boundTask` set passes `taskId: null` to the repo. The same call at `/projects/p/a.md` still passes the root task id.
  - Integration (`describeIf` on `DATABASE_URL`, using `requireCuriaTestDatabase`):
    1. Create `/meetings/agendas/a.md` with `taskId = T` directly through the repo, simulating a legacy stamp.
    2. Create `/projects/p/b.md` with `taskId = T`.
    3. Run `archiveProjectWorkspaceDocs(T)`.
    4. Expect a return of 1, `/meetings/agendas/a.md` still live, and `/projects/p/b.md` archived.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run tests/unit/memory/durable-doc-prefixes.test.ts skills/documents/tools/doc-write/handler.test.ts tests/integration/working-docs-durable-prefix.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - `resolveAssociatedRootTaskId` returns `null` when `isDurableDocPath(input.path)`.
  - `archiveProjectWorkspaceDocs` adds `AND NOT (path LIKE ANY($2::text[]))`, with `$2 = DURABLE_DOC_PREFIXES.map(p => p + '%')`.
  - Comment both sites with `#2322 / #2338: durable prefixes are never task-owned`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -s -m "feat(docs): durable /meetings/ prefix is never task-stamped or project-archived (#2322)"`

### Task 2: Agenda types, validation and `AgendaStore`

**Files:**
- Create: `src/meetings/types.ts`, `src/meetings/agenda-validation.ts`, `src/meetings/agenda-store.ts`
- Test: `tests/unit/meetings/agenda-validation.test.ts`, `tests/integration/meetings-agenda-store.test.ts`

**Interfaces:**
- Produces (`src/meetings/types.ts`):

```ts
export type AgendaSource = 'principal' | 'routine' | 'coordinator' | 'ad_hoc';
export type AgendaSensitivity = 'internal' | 'confidential' | 'shareable';
export type AgendaStatus = 'pending' | 'in_call' | 'done';
export type TopicCoverage = 'covered' | 'partial' | 'not_reached';
export interface TopicCoverageEntry { topic: string; coverage: TopicCoverage }
export interface AgendaHistoryEntry { sessionId: string; date: string /* ISO */; topics: TopicCoverageEntry[] }
export interface AgendaSnapshot {
  agendaId: string; title: string; topics: string[]; role: string | null; context: string;
  source: AgendaSource; sensitivity: AgendaSensitivity; scheduledFor: string | null; history: AgendaHistoryEntry[];
}
export interface AgendaDoc extends AgendaSnapshot {
  path: string; version: number; status: AgendaStatus; expiresAt: string; inCallSession: string | null;
}
export interface AgendaIndexEntry { agendaId: string; title: string; scheduledFor: string | null }
export interface SessionAgendas { loaded: AgendaSnapshot[]; index: AgendaIndexEntry[] }
export interface SessionAgendaLoad { agendaId: string; loadedAt: string; snapshot: AgendaSnapshot }
export interface AgendaCoverage { agendaId: string; topics: TopicCoverageEntry[] }
export interface ParkAgendaInput {
  title: string; topics: string[]; role?: string | null; context: string; source: AgendaSource;
  sensitivity?: AgendaSensitivity; expiresAt?: Date; scheduledFor?: Date | null;
}
```

- Produces (`agenda-validation.ts`):
  - `validateParkAgendaInput(raw: Record<string, unknown>, now: Date): { ok: true; value: ParkAgendaInput & { expiresAt: Date; sensitivity: AgendaSensitivity } } | { ok: false; error: string }`
  - `isDue(agenda: Pick<AgendaSnapshot, 'scheduledFor'>, now: Date): boolean`
- Produces (`agenda-store.ts`): `class AgendaStore { constructor(repo: WorkingDocsRepo, logger: Logger) }` with:
  - `park(input: ParkAgendaInput & { expiresAt: Date; sensitivity: AgendaSensitivity }, now: Date): Promise<AgendaDoc>`: a new UUID; doc type `meeting-agenda`; the body is `context`; `taskId: null`.
  - `get(agendaId: string): Promise<AgendaDoc | null>`
  - `listPending(now: Date): Promise<AgendaDoc[]>`: `status = 'pending'` and not expired, sorted by `scheduledFor` (nulls last), then title.
  - `cullExpired(now: Date): Promise<number>`: archives expired `pending` agendas via `softDeleteAtVersion`. It never touches `in_call` agendas.
  - `lock(agendaId: string, sessionId: string, now: Date): Promise<{ ok: true; agenda: AgendaDoc } | { ok: false; reason: 'not_found' | 'not_pending' | 'expired' | 'conflict' }>`
  - `settle(agendaId: string, sessionId: string, outcome: { kind: 'done' } | { kind: 'return'; history?: AgendaHistoryEntry }): Promise<'settled' | 'not_held'>`:
    - acts only when `status = 'in_call'` and `inCallSession === sessionId`;
    - `done` sets the status and then archives;
    - `return` sets `pending`, clears `inCallSession` and appends `history` if given;
    - re-reads and retries a version conflict up to 3 times, then logs at `error` and returns `'not_held'`.

Frontmatter keys are snake_case: `title`, `topics`, `role`, `source`, `sensitivity`, `status`, `expires_at`, `scheduled_for`, `in_call_session`, `history`. `update()` replaces frontmatter wholesale (`working-docs-repo.ts:267`), so always write the full object.

- [ ] **Step 1: Write the failing unit tests**
  - `validateParkAgendaInput`:
    - accepts a minimal valid input, defaulting `sensitivity: 'internal'` and `expiresAt` to now + 7 days;
    - rejects an empty `topics`, 11 topics, a topic over 200 characters, a title over 120, a role over 500, a context over 6,000;
    - rejects an `expiresAt` beyond now + 30 days, an `expiresAt` in the past, and an unknown `source`/`sensitivity`.
  - `isDue`:
    - `scheduledFor: null` → true;
    - now + 11h → true;
    - now + 13h → false;
    - now − 12h → true.
- [ ] **Step 2: Write the failing integration tests** (real Postgres, `meetings-agenda-store.test.ts`)
  - `park then get round-trips every field`
  - `listPending excludes expired, in_call and done agendas`
  - `cullExpired archives only expired pending agendas`: an expired `in_call` agenda survives.
  - `lock is exclusive`: two concurrent `lock` calls for one agenda yield exactly one `ok: true`.
  - `lock rejects an expired agenda with reason expired`
  - `settle done archives the agenda`
  - `settle return restores pending and appends history`
  - `settle by a different session returns not_held and changes nothing`
  - `settle retries after a version conflict`: bump the doc version with a direct `repo.update` between `get` and `settle` via an injected hook or a spy; expect `'settled'`.
- [ ] **Step 3: Run them and confirm they fail.** Run: `pnpm vitest run tests/unit/meetings/agenda-validation.test.ts tests/integration/meetings-agenda-store.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement the three files to the interfaces above.**
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -s -m "feat(meetings): agenda documents with pending/in_call/done lifecycle (#2322)"`

### Task 3: `meetings` bundle with `meeting-agenda-park`

**Files:**
- Create:
  - `skills/meetings/SKILL.md`
  - `skills/meetings/tools/meeting-agenda-park/tool.json`
  - `skills/meetings/tools/meeting-agenda-park/handler.ts`
  - `skills/meetings/tools/meeting-agenda-park/handler.test.ts`
- Modify: `config/registry-defaults.yaml` (`skills:` list)

**Interfaces:**
- Consumes: `validateParkAgendaInput`, `AgendaStore.park` (Task 2).
- Produces the tool `meeting-agenda-park`:
  - **Manifest:** `"sensitivity": "normal"`, `"action_risk": "low"`, `"allowed_callers": ["coordinator"]`, `"capabilities": ["workingDocs"]`.
  - **Inputs:** `title`, `topics` (array of strings), `context`, `source`, and optional `role`, `sensitivity`, `expires_at` (ISO), `scheduled_for` (ISO).
  - **Outputs:** `agenda_id`, `path`, `expires_at`.

- [ ] **Step 1: Write the failing handler tests**
  - `parks a valid agenda and returns its path under /meetings/agendas/`
  - `returns success:false with the validation error for an oversize context`
  - `returns success:false when the workingDocs capability is missing`: the handler returns an error and never throws.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run skills/meetings`. Expected: FAIL.
- [ ] **Step 3: Implement the handler.**
- [ ] **Step 4: Write `skills/meetings/SKILL.md`**
  - **Frontmatter:** `name: meetings` and `tools: [meeting-agenda-park]`.
  - **Body,** under 40 lines:
    - an agenda is for a principal call;
    - resolve every source into `context` text first, because the call cannot fetch anything;
    - say what's missing rather than linking it;
    - keep to the 6,000-character cap;
    - set `scheduled_for` when the call has a time;
    - the principal can see and edit agendas under `/meetings/agendas/` in the console.
- [ ] **Step 5: Enable the bundle.** Add `meetings` to `skills:` in `config/registry-defaults.yaml`. Do not pin it to the coordinator.
- [ ] **Step 6: Run the coverage and budget tests.** Run: `pnpm vitest run skills/meetings tests/unit/agents/prompt-budget.test.ts tests/unit/skills`. Expected: PASS with no budget edits. If a registry-defaults coverage test exists, it passes.
- [ ] **Step 7: Commit.** `git commit -s -m "feat(meetings): meeting-agenda-park tool in an unpinned meetings bundle (#2322)"`

### Task 4: Voice session store additions

**Files:**
- Modify: `src/channels/voice/session-store.ts`
- Test: `tests/integration/voice-session-store.test.ts`

**Interfaces:**
- Produces:
  - `appendAgendaLoad(id: string, load: SessionAgendaLoad): Promise<void>`: a single `UPDATE … SET metadata = jsonb_set(metadata, '{agendas}', COALESCE(metadata->'agendas', '[]'::jsonb) || $2::jsonb)`.
  - `listRecentWithAgendas(since: Date): Promise<VoiceSessionRecord[]>`: `status IN ('ended','failed')`, `started_at >= since`, and `jsonb_array_length(COALESCE(metadata->'agendas','[]'::jsonb)) > 0`, ordered by `started_at`.
  - `export function sessionAgendaLoads(record: VoiceSessionRecord): SessionAgendaLoad[]`: reads `metadata.agendas` defensively and drops malformed entries with a warn-free filter.

- [ ] **Step 1: Write the failing tests**
  - `appendAgendaLoad appends in order and preserves other metadata keys`
  - `listRecentWithAgendas returns ended and failed sessions with agendas only`: an active session with agendas, a session without agendas and one older than `since` are all excluded.
  - `sessionAgendaLoads ignores malformed entries`
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run tests/integration/voice-session-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -s -m "feat(voice): record agenda loads on voice_sessions metadata (#2322)"`

### Task 5: Agenda prompt block and runtime state

**Files:**
- Create: `src/meetings/agenda-prompt.ts`
- Modify: `src/channels/voice/voice-runtime.ts`:
  - `StartVoiceSessionParams` (:450)
  - `ActiveSession` (:490)
  - `buildVoiceSystemPrompt` (:288)
  - `buildTurnSystemPrompt` (:1370)
  - the tool-call wrapper (:1030-1045)
- Test: `tests/unit/meetings/agenda-prompt.test.ts`, `tests/unit/channels/voice/voice-runtime.test.ts`

**Interfaces:**
- Consumes: `AgendaSnapshot`, `AgendaIndexEntry`, `SessionAgendas`, `SessionAgendaLoad` (Task 2); `VoiceSessionStore.appendAgendaLoad` (Task 4).
- Produces:
  - `formatAgendaPromptBlock(input: SessionAgendas): string | null`. It returns null when both lists are empty.
    - A loaded agenda renders its title, numbered topics, role (if any), the context, and a "left from earlier calls" line built from the last `history` entry, if any.
    - The index lists `agendaId`, title and time, followed by one instruction: call `meeting-agenda-load` with the id of the agenda this call is about, ask the caller if unsure, and load another agenda if the conversation moves to it.
  - `parseAgendaLoadResult(content: string): AgendaSnapshot | null`. It parses the same JSON envelope that `turnDateResolveTracker.recordFromJsonContent` parses for `date-resolve`.
  - `StartVoiceSessionParams.agendas?: SessionAgendas`
  - `buildVoiceSystemPrompt` gets a new optional part, `agendaBlock?: string | null`, inserted immediately before `timeContextBlock`.

- [ ] **Step 1: Write the failing tests**
  - In `agenda-prompt.test.ts`:
    - `returns null for no loaded and no index`
    - `renders a loaded agenda with topics, role and remaining-topics history`
    - `renders an index with load instructions`
    - `parseAgendaLoadResult returns null for an error result or bad JSON`
  - In the existing `buildVoiceSystemPrompt` tests (:1204):
    - `output is byte-identical when agendaBlock is absent or null`: compare with today's call.
    - `agendaBlock sits immediately before the time block`.
  - In the runtime tests, using `makeRuntime` (:188), `FakeStreamProvider` and a fake bridge:
    - `preloaded agenda appears in every turn's system prompt`
    - `a successful meeting-agenda-load result adds the agenda to the next turn's prompt, removes it from the index and calls appendAgendaLoad once`
    - `a failed meeting-agenda-load leaves prompt and store untouched`
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run tests/unit/meetings/agenda-prompt.test.ts tests/unit/channels/voice/voice-runtime.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - Add `loadedAgendas: AgendaSnapshot[]` and `agendaIndex: AgendaIndexEntry[]` to `ActiveSession`, seeded from `params.agendas` in `startSession`.
  - `buildTurnSystemPrompt` passes `agendaBlock: formatAgendaPromptBlock({ loaded, index })`.
  - In the tool-call wrapper, next to the `date-resolve` branch, handle `call.name === 'meeting-agenda-load'` with no `is_error`:
    1. Parse the result.
    2. Push it into `loadedAgendas` and drop it from `agendaIndex`.
    3. `await sessionStore.appendAgendaLoad(...)`.
    - An append failure logs `warn` and does not fail the turn. Task 12's sweep recovers it.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -s -m "feat(voice): render loaded agendas into each turn's prompt (#2322)"`

### Task 6: Principal Signal calls start with their agendas

**Files:**
- Create: `src/meetings/session-agendas.ts`
- Modify: `src/channels/voice/signal/signal-call-bridge.ts` (constructor deps, `handleConnected` :342-458)
- Test: `tests/unit/meetings/session-agendas.test.ts`, `tests/unit/channels/voice/signal/signal-call-bridge.test.ts`

**Interfaces:**
- Consumes: `AgendaStore.cullExpired`, `listPending` and `lock`; `isDue` (Task 2).
- Produces: `prepareSessionAgendas(store: AgendaStore, opts: { sessionId: string; now: Date; logger: Logger }): Promise<{ agendas: SessionAgendas; preload: SessionAgendaLoad | null }>`:
  1. Cull expired agendas.
  2. List pending ones.
  3. If exactly one pending agenda is due, lock it and return it as `preload` and as `loaded[0]`, with the rest empty.
  4. Otherwise return every pending agenda as the index and lock nothing.
  5. If the lock fails, fall back to the index.
  - Any store error logs at `error` and returns empty agendas. It never throws.
- `SignalCallBridge` gets an optional `agendaStore?: AgendaStore` dependency. It prepares agendas only when `caller.systemRole === 'principal'`, writes `agendas: preload ? [preload] : []` into `sessionStore.create` metadata, and passes `agendas` to `startSession`.

- [ ] **Step 1: Write the failing tests**
  - `session-agendas.test.ts`, with a fake `AgendaStore`:
    - `single due agenda is locked and preloaded`
    - `single not-due agenda goes to the index unlocked`
    - `several agendas go to the index unlocked`
    - `lock conflict falls back to the index`
    - `store error yields empty agendas`
  - Bridge tests, extending `setup(opts)` with an `agendaStore` fake:
    - `principal call passes prepared agendas to startSession and records the preload in create metadata`
    - `non-principal caller gets no agendas`: `startSession` has no `agendas`, and the store is never called.
    - `bridge without agendaStore behaves exactly as today`
    - `agenda preparation failure still starts the call free-form`
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run tests/unit/meetings/session-agendas.test.ts tests/unit/channels/voice/signal`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -s -m "feat(voice): principal Signal calls start with parked agendas (#2322)"`

### Task 7: `meeting-agenda-load` voice tool

**Files:**
- Create: `skills/meeting-agenda-load/tool.json`, `skills/meeting-agenda-load/handler.ts`, `skills/meeting-agenda-load/handler.test.ts`
- Modify: `src/channels/voice/voice-tools.ts:23-38` (`VOICE_TOOL_NAMES`), `config/registry-defaults.yaml` (`tools:`, next to `async-offramp` :57), `tests/unit/channels/voice/voice-tools.test.ts`

**Interfaces:**
- Consumes: `AgendaStore.lock` (Task 2), `AgendaSnapshot`.
- Produces the tool `meeting-agenda-load`:
  - **Manifest:** `"action_risk": "low"`, `"allowed_callers": ["coordinator"]`, `"capabilities": ["workingDocs"]`.
  - **Input:** `agenda_id`.
  - **Output:** `agenda: AgendaSnapshot` on success, which Task 5's `parseAgendaLoadResult` consumes.
  - It is voice-only, like `async-offramp`: without `ctx.taskMetadata?.voiceSessionId` it returns `success: false`, `"meeting-agenda-load is only available on a live voice call"`.
  - Failures map `lock` reasons to short spoken-friendly errors, e.g. `expired` → "That agenda has expired."

- [ ] **Step 1: Write the failing tests**
  - `locks the agenda for the voice session and returns its snapshot`
  - `rejects outside a voice session`
  - `maps not_pending and expired to spoken-friendly errors`
  - In the voice-tools test: `VOICE_TOOL_NAMES includes meeting-agenda-load`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run skills/meeting-agenda-load tests/unit/channels/voice/voice-tools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement and register the tool.**
- [ ] **Step 4: Run the tests and the budget test.** Run: `pnpm vitest run skills/meeting-agenda-load tests/unit/channels/voice tests/unit/agents/prompt-budget.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -s -m "feat(voice): meeting-agenda-load lets the shim switch agendas mid-call (#2322)"`

### Task 8: Transcript source rows and transcript builder

**Files:**
- Modify: `src/memory/working-memory.ts` (`StorageBackend` :84-103, both backends, public API next to `getHistory` :151)
- Create: `src/meetings/transcript.ts`
- Test: `tests/unit/memory/working-memory-transcript-rows.test.ts` (in-memory backend), `tests/integration/working-memory-transcript-rows.test.ts`, `tests/unit/meetings/transcript.test.ts`

**Interfaces:**
- Produces:
  - `export interface TranscriptSourceRow { role: 'user' | 'assistant' | 'system'; content: string; createdAt: Date; senderContactId: string | null; synthetic: boolean; archived: boolean }`
  - `WorkingMemory.getTranscriptRows(conversationId: string, agentId: string): Promise<TranscriptSourceRow[]>`: every row, archived included, ordered by `created_at, id`.
  - `buildTranscriptDoc(input: { session: VoiceSessionRecord; loads: SessionAgendaLoad[]; rows: TranscriptSourceRow[]; callerName: string }): { frontmatter: Record<string, unknown>; body: string; turnCount: number }`:
    - keeps only user rows with `synthetic = false`, and assistant rows (correction 5);
    - labels lines `**<callerName>:**` and `**Curia:**`;
    - frontmatter: `session_id`, `conversation_id`, `participants` (`[{ contact_id, name }]`, caller then Curia with `contact_id: null`), `agendas` (`[{ agenda_id, loaded_at }]`), `started_at`, `ended_at`, `end_reason`, `turn_count`, `ttl_days: 14`, `notes: "Turns are persisted best-effort; timestamps are persistence time, not speech time."`
  - `export function transcriptPath(sessionId: string): string`, which returns `/scratch/meeting-${sessionId}/transcript.md`.
  - `export function callerSpokeAfter(rows: TranscriptSourceRow[], at: Date): boolean`

- [ ] **Step 1: Write the failing tests**
  - `getTranscriptRows returns archived rows and the summary row in created_at order`: the integration test forces summarisation, or inserts archived rows plus a `[Conversation summary]\n` system row directly.
  - `buildTranscriptDoc drops summary, system and synthetic rows but keeps archived user and assistant rows`
  - `buildTranscriptDoc frontmatter carries ttl_days 14 and the agenda loads`
  - `callerSpokeAfter is false when the only user rows predate the load`
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run tests/unit/memory/working-memory-transcript-rows.test.ts tests/integration/working-memory-transcript-rows.test.ts tests/unit/meetings/transcript.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - Postgres: `SELECT role, content, created_at, sender_contact_id, synthetic, archived FROM working_memory WHERE conversation_id = $1 AND agent_id = $2 ORDER BY created_at, id`.
  - In-memory: the same filter over its rows.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -s -m "feat(meetings): build call transcripts from raw working_memory rows (#2322)"`

### Task 9: Minutes writer

**Files:**
- Create: `src/meetings/minutes-writer.ts`
- Test: `tests/unit/meetings/minutes-writer.test.ts`

**Interfaces:**
- Consumes: `InfraLlm` (`src/skills/infra-llm.ts:49-55`); `encodeUntrustedJson`, `stripCodeFence` and `extractFirstJsonObject` (`src/util/json-extract.ts`); `AgendaSnapshot`, `AgendaCoverage`.
- Produces:
  - `buildMinutesPrompt(input: { agendas: AgendaSnapshot[]; transcriptBody: string }): string`. Agendas and transcript go in through `encodeUntrustedJson`. The model is told to write markdown minutes with:
    - one section per agenda, topic by topic: discussed, decided, and coverage (`covered`, `partial` or `not_reached`);
    - a section for anything discussed outside the agendas;
    - open questions kept as they were said;
    - attribution of who said or committed to what;
    - then, last, one fenced `json` block `{"coverage":[{"agendaId":…,"topics":[{"topic":…,"coverage":…}]}]}`.
  - `parseMinutesOutput(raw: string, agendas: AgendaSnapshot[]): { markdown: string; coverage: AgendaCoverage[] | null }`:
    - `markdown` is the text with the trailing JSON block removed.
    - `coverage` is null when the block is missing or malformed.
    - Unknown agenda ids and topics are dropped. A topic the model omitted counts as `not_reached`.
  - `writeMinutes(llm: InfraLlm, input: { agendas: AgendaSnapshot[]; transcriptBody: string }): Promise<{ ok: true; markdown: string; coverage: AgendaCoverage[] | null } | { ok: false; error: string }>`:
    - `tier: 'standard'`, `maxTokens: 8000`;
    - `ok: false` when the LLM fails or returns empty markdown.

- [ ] **Step 1: Write the failing tests** (fake `InfraLlm`)
  - `parses markdown and coverage from a well-formed response`
  - `missing coverage block returns every agenda to pending`: `coverage` is null and `markdown` is the full text.
  - `unknown agendaId and unknown topics are dropped; omitted topics are not_reached`
  - `LLM error yields ok:false with the error`
  - `prompt wraps transcript and agendas with encodeUntrustedJson`
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run tests/unit/meetings/minutes-writer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -s -m "feat(meetings): standard-tier minutes writer with structured topic coverage (#2322)"`

### Task 10: Events and the session-end pipeline

**Files:**
- Modify:
  - `src/bus/events.ts`: payloads, events, union (:2041-2112) and factories, following the `activity.summary` pattern (:516, :1520, :3032)
  - `src/bus/permissions.ts`: system publish (:91) and system subscribe (:108)
- Create: `src/meetings/minutes-pipeline.ts`, plus `MeetingSessionEndedSubscriber` in `src/meetings/subscribers.ts`
- Test: `tests/unit/bus/permissions.test.ts`, `tests/integration/meetings-minutes-pipeline.test.ts`

**Interfaces:**
- Produces events. Keep `events.ts` free of imports from `src/meetings`, and inline the literal unions:
  - `minutes.ready`: `{ minutesRef: string; sessionId: string; conversationId: string; sources: Array<'principal'|'routine'|'coordinator'|'ad_hoc'>; sensitivity: 'internal'|'confidential'|'shareable' }`, created by `createMinutesReady(payload)`.
  - `minutes.pipeline_failed`: `{ sessionId: string; stage: 'transcript' | 'minutes' | 'settle' | 'structuring'; error: string }`, created by `createMinutesPipelineFailed(payload)`.
  - Both are `sourceLayer: 'system'`. Publishing them is how failures are audited, because the audit log writes ahead every published event (`src/index.ts:461-465`).
- Produces `class MinutesPipeline`:
  - `constructor(deps: { sessionStore: VoiceSessionStore; workingMemory: WorkingMemory; repo: WorkingDocsRepo; agendaStore: AgendaStore; llm: InfraLlm; taskRepo: TaskRepo; contactService: ContactService; bus: EventBus; timezone: () => string; logger: Logger })`
  - `run(sessionId: string): Promise<'skipped' | 'returned_unused' | 'completed' | 'failed'>`
  - `export function minutesPath(sessionId: string, startedAt: Date, tz: string): string`, built with luxon `setZone(tz).toISODate()`.
- Produces `class MeetingSessionEndedSubscriber`:
  - `constructor(opts: { bus: EventBus; pipeline: MinutesPipeline; logger: Logger })` and `start(): void`;
  - it subscribes to `'voice.session.ended'` on `'system'` and calls `void pipeline.run(id).catch(...)`, never awaiting it, because bus delivery is sequential (`src/bus/bus.ts:216-248`).

**`run(sessionId)` algorithm** (the steps are ordered, and each is idempotent):

1. Load the session. If there are no agenda loads, return `'skipped'`. An in-memory `Set` of in-flight session ids makes a concurrent second `run` return `'skipped'`.
2. Read `getTranscriptRows('voice:'+id … )`. That id is `session.conversationId`, with agent `'coordinator'`. An agenda *counts* if `callerSpokeAfter(rows, loadedAt)`. If none counts, `settle` each one with `{ kind: 'return' }` (no history) and return `'returned_unused'`.
3. **Transcript.** If `repo.read(transcriptPath)` is null, `create` it with type `meeting-transcript`. A unique violation (`23505`, from `idx_working_documents_path_live`) counts as already written.
4. **Minutes.** If the minutes doc is missing, call `writeMinutes`. On `ok: false`, publish `minutes.pipeline_failed { stage: 'minutes' }`, log at `error`, and return `'failed'`; agendas stay `in_call` for the sweep. Otherwise `create` the doc with type `meeting-minutes`, the markdown body, and frontmatter `session_id`, `agenda_ids`, `sources`, `sensitivity`, `transcript_ref`, `started_at`.
   - `sensitivity` is the most restrictive of the counted agendas: `confidential` > `internal` > `shareable`.
   - If the doc already exists, coverage is unknown on this pass, so treat it as null.
5. **Settle** each counted agenda:
   - every topic `covered` → `{ kind: 'done' }`;
   - otherwise → `{ kind: 'return', history: { sessionId, date, topics } }`;
   - null coverage → `return` with every topic `not_reached`.
   - Uncounted loaded agendas → `{ kind: 'return' }`.
   - A `'not_held'` result is fine: it was already settled.
6. If `taskRepo.listTasks({ tag: 'meeting-minutes:'+id })`, with every status, is empty, publish `minutes.ready`. Return `'completed'`.

Any thrown error in steps 3–6 publishes `minutes.pipeline_failed` with that stage, logs at `error`, and returns `'failed'`. `run` itself never rejects.

- [ ] **Step 1: Write the failing permissions tests**, copying the `activity.summary` template (`permissions.test.ts:263-270`): `allows only the system layer to publish and subscribe to minutes.ready` and the same for `minutes.pipeline_failed`.
- [ ] **Step 2: Write the failing pipeline integration tests** (real Postgres, real `EventBus` + `AuditLogger` as in `tests/integration/late-delegation.test.ts:162-189`, fake `InfraLlm`):
  - `writes transcript and minutes once and publishes minutes.ready`: run `run` twice, then expect one minutes doc, and one `minutes.ready` if a structuring task now exists with the tag.
  - `dropped call still produces minutes`: `end_reason` is `remote_hangup` after two turns.
  - `hijacked call returns the agenda with history`: the caller speaks after the load, and coverage marks every topic `not_reached`.
  - `fully covered agenda is done and archived`
  - `caller silent after load returns the agenda without minutes` → `'returned_unused'`.
  - `minutes LLM failure publishes minutes.pipeline_failed and leaves the agenda in_call`
  - `session without agenda loads is skipped`
  - Unit, `tests/unit/meetings/subscribers.test.ts`, with a fake pipeline whose `run` never resolves:
    - `voice.session.ended handler returns before the pipeline settles`, so teardown is never delayed.
    - `a rejected pipeline run is logged, not thrown`.
- [ ] **Step 3: Run them and confirm they fail.** Run: `pnpm vitest run tests/unit/bus/permissions.test.ts tests/unit/meetings/subscribers.test.ts tests/integration/meetings-minutes-pipeline.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the events, permissions, `MinutesPipeline` and `MeetingSessionEndedSubscriber`.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -s -m "feat(meetings): session-end pipeline writes transcript and minutes, emits minutes.ready (#2322)"`

### Task 11: Structuring task and playbook

**Files:**
- Create: `skills/meeting-minutes-structuring/SKILL.md`, plus `MinutesReadySubscriber` in `src/meetings/subscribers.ts`
- Modify: `config/registry-defaults.yaml` (`skills:`)
- Test: `tests/integration/meetings-structuring-task.test.ts`, `tests/unit/skills/meeting-minutes-structuring-skill.test.ts`

**Interfaces:**
- Consumes: `minutes.ready` (Task 10); `TaskRepo.createTask`, `setActiveSkillsBlock` and `listTasks`; `replaceActiveSkillsBlock` (`src/db/active-skills-progress.ts:127`); `SchedulerService.enqueueTaskWake` (`src/scheduler/scheduler-service.ts:1296`; call shape at `src/agents/plan-frontier.ts:157`); `makeSystemOriginator()` (`src/contacts/principal.ts:137`).
- Produces `class MinutesReadySubscriber`, with `constructor(opts: { bus: EventBus; taskRepo: TaskRepo; schedulerService: SchedulerService; logger: Logger })` and `start(): void`. On each `minutes.ready`:
  1. If a task tagged `meeting-minutes:<sessionId>` exists, do nothing.
  2. Otherwise `createTask` with:
     - `agentId: 'coordinator'`, `owner: 'curia'`, `source: 'scheduler'`, `createdBy: 'meetings'`;
     - `title: 'Follow up on meeting minutes'`;
     - `description` containing the `minutesRef`, `sources` and `sensitivity`;
     - `tags: ['meeting-minutes:<sessionId>']`;
     - `originator: makeSystemOriginator()`;
     - no `wakeAt` (correction 3).
  3. `setActiveSkillsBlock(task.id, replaceActiveSkillsBlock(['meeting-minutes-structuring']))`.
  4. `enqueueTaskWake` for the task.
  - A failure publishes `minutes.pipeline_failed { stage: 'structuring' }` and logs at `error`.

**Playbook** (`skills/meeting-minutes-structuring/SKILL.md`): frontmatter `name: meeting-minutes-structuring` and `description` only, no `tools:`. The body is under 60 lines and covers:
- **Read** the minutes with `doc-read`, using the `minutesRef` in the task.
- **The issue's three-row rule (D7):**
  - The principal **explicitly directed** a change: do it. The autonomy gates apply.
  - **Curia's own idea:** suggest it in the report and don't act on it.
  - Something going to a **third party:** draft it with `email-draft-save`, or ask in the report. Never send it in this task.
  - Calendar invite updates from a directed change are fine.
- **Tasks:** create them with owner `ceo`, `curia` or `external` taken from attribution.
- **Report:** always send one to the recipient `principal` through the normal send skills, on the usual channel. Label each action *directed* or *Curia's idea*, list the suggestions, and give the minutes path.
- **Finish:** complete the task.

- [ ] **Step 1: Write the failing tests**
  - Integration:
    - `minutes.ready creates exactly one coordinator task with the tag, system originator and active skill, and enqueues a wake`
    - `a second minutes.ready for the same session creates nothing`
  - Unit:
    - `meeting-minutes-structuring loads as an instruction-only skill and is activatable by the coordinator`, through `resolveSkillActivation` (`src/skills/skill-activation.ts`).
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run tests/integration/meetings-structuring-task.test.ts tests/unit/skills/meeting-minutes-structuring-skill.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the subscriber, write the SKILL.md and enable it in `registry-defaults.yaml`.**
- [ ] **Step 4: Run the tests and the budget test.** Run: `pnpm vitest run tests/integration/meetings-structuring-task.test.ts tests/unit/skills tests/unit/agents/prompt-budget.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -s -m "feat(meetings): minutes.ready wakes one coordinator structuring task with a lazy playbook (#2322)"`

### Task 12: Recovery sweep and wiring

**Files:**
- Create: `src/meetings/recovery.ts`
- Modify: `src/index.ts`
- Test: `tests/integration/meetings-recovery.test.ts`

**Interfaces:**
- Consumes: `VoiceSessionStore.listRecentWithAgendas`, `sessionAgendaLoads` (Task 4); `MinutesPipeline.run` (Task 10); `AgendaStore` (Task 2).
- Produces `class MeetingPipelineRecovery`, with `constructor(deps: { sessionStore: VoiceSessionStore; agendaStore: AgendaStore; repo: WorkingDocsRepo; pipeline: MinutesPipeline; logger: Logger; lookbackDays?: number /* 7 */ })` and `sweep(now: Date): Promise<{ rerun: number; released: number }>`:
  1. Run `pipeline.run(id)` sequentially for each `listRecentWithAgendas(now − lookback)` session.
  2. Archive expired agendas with `agendaStore.cullExpired(now)`.
  3. For every `in_call` agenda whose `in_call_session` is not an `active` session, and is not among the sessions just rerun with an outcome of `'completed'` or `'returned_unused'`, `settle` it with `{ kind: 'return' }`.
  - Step 3 runs after step 1, so a failed rerun's agendas are released. It finds `in_call` agendas through `repo.listByPrefix('/meetings/agendas/')`.

**Wiring in `src/index.ts`,** inside `if (workingDocsRepo)`:
- Build one `AgendaStore` and pass it to `SignalCallBridge`'s constructor.
- Build `MinutesPipeline` with `infraLlmService.scoped({ toolName: 'meeting-minutes' })` and a timezone getter: `principalContact?.timezone ?? config.timezone`, read at call time.
- Start both subscribers next to `DeliverableKgPromotionSubscriber` (:2998-3008).
- Run `void recovery.sweep(new Date()).catch(...)` after the checkpoint processor (:3275) and before `httpAdapter.start()` (:3367), so it never delays boot.

- [ ] **Step 1: Write the failing tests**
  - `failed/process_restart session with a counted agenda gets transcript, minutes and minutes.ready from the sweep`
  - `crash after minutes before minutes.ready is completed by the sweep`
  - `orphaned in_call agenda is released`: an agenda is `in_call` for an ended session that has no metadata record of the load.
  - `sweep ignores sessions older than the lookback`
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm vitest run tests/integration/meetings-recovery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the recovery class and the wiring.**
- [ ] **Step 4: Run the tests, the typecheck and the related unit suites.**
  - Run: `pnpm vitest run tests/integration/meetings-recovery.test.ts tests/unit/meetings tests/unit/channels/voice`
  - Run: `pnpm -C <worktree> run typecheck`
  - Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -s -m "feat(meetings): startup sweep recovers interrupted meeting pipelines; wire meetings (#2322)"`

### Task 13: Docs, CHANGELOG and the Signal dry run

**Files:**
- Modify: `skills/documents/SKILL.md` (one short paragraph), `CHANGELOG.md` (`## [Unreleased]`)

- [ ] **Step 1: Document `/meetings/` in `skills/documents/SKILL.md`.**
  - It holds agendas and minutes written by the meetings pipeline.
  - It is durable and never task-owned.
  - Agendas are edited through `meeting-agenda-park` or the console.
- [ ] **Step 2: Add CHANGELOG bullets** under **Added**, each at most 15 words after the em-dash:
  - **Agenda-driven calls**: principal calls start from parked agendas; Curia can switch agendas mid-call. (#2322)
  - **Meeting minutes**: calls with an agenda produce a transcript, minutes and one follow-up report. (#2322)
  - **Bus events**: `minutes.ready` and `minutes.pipeline_failed`, system-only. (#2322)
- [ ] **Step 3: Run the full unit suite and the typecheck.**
  - Run: `pnpm vitest run tests/unit` and `pnpm -C <worktree> run typecheck`.
  - Expected: PASS. A flaky integration failure must be re-checked on a pristine DB before it is blamed on this change.
- [ ] **Step 4: Do the manual Signal dry run** on a non-production deploy, and record it in the PR:
  1. Park two agendas through the coordinator: "activate meetings, park X and Y".
  2. The principal calls in.
  3. Curia picks one, and switches to the other mid-call.
  4. The transcript, minutes and structuring report arrive. Actions are labelled and suggestions listed.
  5. A third call taken over by an unrelated topic leaves its agenda `pending` with history.
- [ ] **Step 5: Commit.** `git commit -s -m "docs(meetings): document /meetings/ and changelog for agenda-driven calls (#2322)"`

---

## Known limitations, carried from the issue

- **The report can be held below autonomy 70.** The structuring task's report send goes through autonomy gates A and B, because it isn't principal-originated. #2337 tracks exempting principal-only sends. Don't change the gates here.
- **No fact extraction from voice calls.** Voice calls get no checkpoint fact extraction (`src/dispatch/dispatcher.ts:568`). That's unchanged.
- **Console calls get no agendas.** The console voice path (`src/channels/voice/voice-adapter.ts:142`) does not prepare agendas in this slice. To add it later, call `prepareSessionAgendas` there.
