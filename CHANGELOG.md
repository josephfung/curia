# Changelog

All notable changes to Curia are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0: minor bumps introduce new capabilities; patch bumps fix bugs. Breaking changes
to public API surfaces (skill manifest schema, `SkillContext` interface, agent YAML schema,
bus event types) are noted explicitly even in the `0.x` range.

---

## [Unreleased]

### Changed
- **`docs/specs/00-overview.md` spec index** — added Status column, rows 12–16 (Knowledge Graph Web Explorer, Office Identity, Autonomy Engine, Outbound Safety, Smoke Test Framework), and unified Scope notes with README Area column (channels named explicitly, cron/one-shot in scheduler, unknown sender policy in contacts, KG-backed profiles in entity context enrichment).
- **README.md** — removed Project Status & Documentation table; status is now consolidated in `docs/specs/00-overview.md`.

### Added
- **Spec 11 implementation status table** — added Implementation Status section to `docs/specs/11-entity-context-enrichment.md` documenting what's done and what's outstanding across all three phases.
- **Conversation checkpoint pipeline** — Dispatch publishes a `conversation.checkpoint` event after 10 minutes of inactivity per conversation–agent pair. A new System Layer `ConversationCheckpointProcessor` subscribes, concatenates new turns since the last watermark, fans out to background memory skills (`extract-relationships`; extensible to future skills), then advances the per-(conversationId, agentId) watermark in the new `conversation_checkpoints` table. Adds migration 017. **Breaking change:** `conversation.checkpoint` added to the bus event type discriminated union.

### Changed
- **`extract-relationships` moved to checkpoint pipeline** — extraction now runs once per conversation–agent pair (after 10 min of inactivity) rather than as an LLM tool call on every message. Fixes the coordinator confabulation bugs (see PR #221).

### Fixed
- **Coordinator confabulation bug** — removed `extract-relationships` from the coordinator's LLM tool loop. The per-message tool call caused empty-text turns that triggered the empty-response recovery mechanism, which confabulated "I already provided my response" in Signal group chats and the web UI. Relationship extraction moves to the conversation checkpoint pipeline (forthcoming).
- **KG node deduplication** — one-time migration deduplicates existing `kg_nodes` rows with matching `(lower(label), type)`, re-pointing edges and contacts to canonical nodes before removing duplicates.

### Added
- **`kg_nodes` uniqueness constraint** — `idx_kg_nodes_unique` on `(lower(label), type) WHERE type != 'fact'` prevents future duplicate entity nodes.
- **`KnowledgeGraphStore.upsertNode()`** — idempotent node creation; raises confidence on conflict, never creates duplicates. Returns `{ node, created }`.
- **`EntityMemory.createEntity()`** — now returns `{ entity, created }` instead of `KgNode`. Delegates to `upsertNode` for race-safe creation. **Breaking change** for callers (all internal call sites updated).
- **`EntityMemory.updateNode()`** — new public method. Label changes that collide with an existing node of the same type automatically merge the nodes. Returns `{ node, merged }` — callers must use the returned `node.id`, which may differ from the input id when `merged: true`.
- **`mergeEntities` Phase 2** — re-points secondary entity edges to primary and deletes the secondary node (was previously deferred with a TODO).

---

## [0.12.1] — 2026-04-07

### Added
- **Signal channel** (spec 04): inbound and outbound messaging via signal-cli daemon socket. Includes group trust model.
- **Development setup guide** (`docs/dev/setup.md`): tiered setup guide for contributors covering minimum (Anthropic + Postgres), recommended (+ Nylas + OpenAI), and full (+ Signal + Tavily) configurations. 
### Changed
- **README clean up** Condensed Quick Start, cleaned up Web App section, and updated project table.

---

## [0.11.0] — 2026-04-07

### Added
- **Bullpen (Tier 2 inter-agent discussion)** — shared threaded workspace where agents can open, reply to, and close discussion threads. Flows through the bus as `agent.discuss` events. BullpenDispatcher routes discuss events to `agent.task` for all thread participants. Pending threads injected into agent context before every LLM call. Visible to dashboards via SSE stream. Implements spec 01 (lines 24–44). Closes #25.

---

## [0.10.0] — 2026-04-07

### Security
- **Inbound message sanitization: prompt injection detection (Layer 1)** — `Dispatcher.handleInbound()` now scans messages that pass the blocked/held/rejected sender policy gates before routing them to the Coordinator's LLM. Instruction-mimicking XML/HTML tags (`<system>`, `<instructions>`, `<prompt>`, `<context>`, `<assistant>`, `<user>`) are stripped from message content; instruction-like phrases ("ignore previous instructions", "act as", "you are now", etc.) are detected via configurable regex. Flagged messages are tagged with a `risk_score` (0–1) in the `agent.task` event metadata — not blocked — and are automatically captured in the audit log. Extra patterns can be added to `config/default.yaml` under `security.extra_injection_patterns` without code changes (spec §06, closes #190).
- **Tool output sanitization** — execution layer now enforces a configurable character limit on all skill results (default 200k chars, set via `skillOutput.maxLength` in `config/default.yaml`), appending `[truncated — output exceeded limit]` when exceeded. All error paths in `ExecutionLayer.invoke()` now sanitize the error message and wrap it in `<skill_error>` tags before publishing to the bus, preventing error content from external sources from being misinterpreted as system instructions (closes #191). Cleanup: `loadYamlConfig()` added to `src/config.ts` with a typed `YamlConfig` interface so `default.yaml` is properly parsed rather than accessed via unsafe casts; browser config cast tracked as cleanup in #204.
- **Dummy credential placeholders** — replaced `curia_dev` in `.env.example` and `docker-compose.yml` defaults with obviously-dummy `your-db-user` / `your-db-password` values to eliminate false-positive secrets scanner alerts (closes #50).
- **Elevated-skill gate: remove CLI channel bypass** — the `caller.channel !== 'cli'` branch in `src/skills/execution.ts` was redundant (the contact resolver already maps CLI callers to `role: 'ceo'`) and created latent attack surface: any future code path that published an `inbound.message` event with `channelId: 'cli'` and a non-CEO sender would have passed the gate. Gate now relies solely on `caller.role`.

### Added
- **Scheduler stuck-job recovery** — startup sweep and 5-minute watchdog detect jobs stuck in `running` state beyond their timeout threshold and reset them to `pending`. Adds `run_started_at` (set on job claim, cleared on completion) and `expected_duration_seconds` (per-job timeout hint, sourced from YAML or job creation) columns to `scheduled_jobs`. Timeout formula: `min(expected × 7.5, expected + 60m)`. Recovery increments `consecutive_failures`; third consecutive recovery suspends the job. Emits `schedule.recovered` audit event per recovered job. Resolves silent failure mode observed 2026-04-07.

### Changed
- **Agent YAML `schedule` entries** — optional `expectedDurationSeconds` field added to the schedule entry type in `AgentYamlConfig`; used to set a per-job stuck-job recovery timeout.
- **`ValidationResult` 'create' variant** — replaced `{ node: KgNode }` with `{ validated: ValidatedFactData }`, a narrower type that only carries label, properties, temporal metadata, and embedding. Removes the wasted `createNodeId()` call in the validator and makes the ownership boundary explicit: the validator validates, the store mints the ID and persists. (Closes #30)

### Fixed
- **Scheduled Jobs page auth** — `/api/jobs` routes now use session-cookie auth (same as KG/identity routes) instead of the global Bearer token hook, so the dashboard can load the page without an `Unauthorized` error.
- **Calendar skill timestamp display** — all calendar skills (`calendar-list-events`, `calendar-create-event`, `calendar-update-event`, `calendar-check-conflicts`, `calendar-find-free-time`) now return event and slot timestamps as UTC ISO 8601 strings instead of raw Unix seconds. LLMs can't reliably convert Unix epoch integers to wall-clock times (wrong times were displayed to the user); ISO strings are unambiguous and correctly interpreted using the timezone already in the system prompt.
- **contact-service useless catch** — removed no-op try/catch in `createContact` that caught and immediately rethrew without adding any logic; preserved the KG orphan TODO as a comment at the call site (issue #49).

---

## [0.9.0] — 2026-04-06

### Added
- **Onboarding wizard** — multi-step full-screen wizard guides new users through configuring the office identity (assistant name, tone, communication style, decision posture) on first run. Re-enterable from Settings → Setup Wizard. Requires the identity service (spec 13) to be configured.
- **Settings nav** — new collapsible Settings section in the sidebar with Setup Wizard sub-item.
- **`configured` flag on `GET /api/identity`** — returns `false` until the wizard or API has saved an identity explicitly; used for first-run detection in the browser without client-side state.

### Changed
- **Default landing screen** — the app now lands on Chat instead of Knowledge Graph after login.
- **Session auth refactor** — `assertSecret()` extracted to `src/channels/http/session-auth.ts`; sessions store lifted to `HttpAdapter` so identity routes now accept the `curia_session` cookie in addition to the `x-web-bootstrap-secret` header.

---

## [0.8.0] — 2026-04-06

### Added
- **Scheduled Jobs UI** — management view in the web app for creating, editing, deleting, and unsuspending scheduled jobs; full CRUD via `/api/jobs` with search by agent, status, cron expression, and intent

---

## [0.7.0] — 2026-04-06

### Added
- **`query-relationships` skill** — query KG edges by entity name with optional edge-type filter
- **`delete-relationship` skill** — delete a KG edge by triple (subject, predicate, object); idempotent and direction-agnostic
- **Agent Tasks UI** — search and CRUD management view for agent tasks in the web app
- **Architecture Decision Records** — `docs/adr/` with 12 backfilled ADRs covering major technical decisions (closes #7)

### Changed
- **`KnowledgeGraphStore.upsertEdge()`** — now atomic (`ON CONFLICT DO UPDATE`); eliminates pre-query race condition in concurrent extractions

### Fixed
- **KG chat blank reply** — coordinator prompt clarified so `extract-relationships` does not suppress the text response; runtime retries with a nudge turn when the LLM produces no text, then falls back to a safe message
- **KG viewport blank** — switched canvas sizing to `position: absolute; inset: 0`; fixed Cytoscape asset path via `createRequire`; added `cy.resize()` before layout and on navigate
- **Calendar skill input types** — corrected bare `array` / `array?` in `calendar-update-event`, `calendar-find-free-time`, and `calendar-check-conflicts` to valid JSON Schema types (`object[]?`, `string[]`); caused startup crashes
- **Duplicate `extract-relationships` in coordinator** — removed duplicate `pinned_skills` entry that caused Anthropic to receive two identical tool definitions
- **Skill input schema format** — `query-relationships` and `delete-relationship` used invalid `"string — description"` shorthand; corrected to `"string (description)"`; caused 400 errors on every chat request

---

## [0.6.0] — 2026-04-05

### Added
- **`extract-relationships` skill** — two-stage LLM pipeline (Haiku classifier gate + Sonnet extractor) that extracts entity-to-entity relationship triples from text and persists them to the KG; coordinator calls it after every message
- **12 new `EDGE_TYPES`** — personal (spouse, parent, child, sibling), professional (reports_to, manages, collaborates_with, advises, represents), organisational (member_of, founded, invested_in)
- **`EntityMemory.upsertEdge()`** — idempotent edge persistence with bidirectional duplicate detection; confidence only increases on re-assertion
- **`EntityMemory.createEntity()` confidence option** — extracted nodes can be seeded at 0.6 (below manually confirmed entities)
- **Contact deduplication** — `DedupService` scores pairs using Jaro-Winkler name similarity and channel identifier overlap; thresholds: ≥ 0.9 = `certain`, 0.7–0.9 = `probable`; fires on contact creation
- **Contact merge** — `ContactService.mergeContacts()` produces a golden record (most-recent-wins for scalars, union for identities); `EntityMemory.mergeEntities()` consolidates KG nodes
- **`contact-find-duplicates` skill** — read-only scan with optional `min_confidence` filter
- **`contact-merge` skill** — `dry_run` defaults to `true`; returns `MergeProposal` before committing; elevated caller required
- **Contacts CRUD UI** — search, create, edit, and delete contacts from the KG web app
- **Bus events** — `contact.duplicate_detected` and `contact.merged` (PII-free reason strings)

### Changed
- **`EntityMemory.upsertEdge()`** — delegates to `KnowledgeGraphStore.upsertEdge()` for atomic upsert

### Fixed
- **`kg_edges` uniqueness** — migration 014 adds a bidirectional unique index; concurrent extractions can no longer create duplicate edges
- **`extract-relationships` missing from coordinator** — skill was absent from `pinned_skills`; tool calls silently failed; added and verified

---

## [0.5.0] — 2026-04-05

### Added
- **Office Identity Engine** — runtime-configurable persona (name, title, email, tone, pronouns)
  stored in Postgres with a `GET/PUT /api/identity` HTTP API; persona fields interpolated into
  agent system prompts at task time (spec 13)
- **`action_risk` on skill manifests** — required field declaring each skill's minimum autonomy
  score; validated at startup; Phase 2 will enforce the gate at invocation time
- **Developer guides** — `docs/dev/adding-a-skill.md` and `docs/dev/adding-an-agent.md`
- **Specs 14 & 15** — Autonomy Engine (full) and Outbound Safety (stub with TODO)
- **Smoke test contributor guide** — `docs/dev/smoke-tests.md` with YAML schema, worked examples,
  and tag reference

### Changed
- Docs reorganized: timestamped work artifacts consolidated into `docs/wip/`; removed redundant
  `docs/plans/`, `docs/specs/designs/`, and `docs/superpowers/` directories
- Telegram removed as a planned channel (Signal remains the high-trust messaging channel)

---

## [0.4.0] — 2026-03-28

### Added
- **Autonomy Engine Phase 1** — global score (0–100), five bands, CEO controls via
  `get-autonomy` / `set-autonomy` skills, per-task prompt injection into Coordinator
- **Entity context enrichment** — KG-backed sender/entity profiles injected into inbound
  messages before agent dispatch (spec 11)
- **Web search skill** — Tavily-backed `web-search` with ranked results
- **Web browser skill** — Playwright-based `web-browser` for JS-rendered pages;
  warm browser instance managed by `BrowserService`
- **KG web explorer** — browser UI for inspecting the knowledge graph (Cytoscape.js,
  served from `node_modules`, gated by `WEB_APP_BOOTSTRAP_SECRET`; spec 12)
- **Timezone-aware scheduling** — per-job timezone flows through `SchedulerService`;
  `scheduler-create` skill exposes `timezone` input; `ExecutionLayer` normalizes
  `timestamp` inputs to UTC before dispatch
- **Calendar skills** — `calendar-register`, `calendar-list-events`, `calendar-create-event`,
  `calendar-update-event`, `calendar-delete-event`, `calendar-find-free-time`,
  `calendar-check-conflicts`, `calendar-list-calendars`

### Changed
- `autonomy_floor` renamed to `action_risk` on skill manifests (breaking change to manifest
  schema; all built-in skills updated)

---

## [0.3.0] — 2026-03-10

### Added
- **Email channel** — Nylas-backed inbound/outbound email; HTML formatting for outbound bodies
- **Contacts & identity service** — contact creation, lookup, role assignment, permission grants,
  identity linking across channels (spec 9)
- **Unknown sender policy** — hold-for-review queue, provisional senders, configurable policy
  per channel
- **Error recovery** — error budgets (`max_turns`, `max_cost_usd`, `max_errors`), failure pattern
  detection, state continuity across restarts (spec 5)
- **Outbound content filter** — deterministic Stage 1 rules: system prompt fragments, internal
  structure leakage, known secret patterns, contact data exfiltration (later formalized as
  spec 15; Stage 2 LLM-as-judge is planned)
- **Smoke test framework** — 14 chat-based cases, LLM-as-judge evaluation, HTML reports

### Changed
- Coordinator prompt tuned for contact-aware routing

---

## [0.2.0] — 2026-02-20

### Added
- **Skills & execution layer** — local skill manifests (`skill.json`), `SkillHandler` interface,
  `SkillContext` with secrets access, input validation, output sanitization, per-invocation
  timeout enforcement (spec 3)
- **Multi-agent delegation** — `delegate` skill; agents can hand off tasks to named specialists
- **HTTP API channel** — REST endpoints for web-based task submission
- **Knowledge graph** — `kg_nodes` / `kg_edges` Postgres schema with pgvector embeddings;
  entity memory reads/writes via `EntityMemory` (spec 1 partial)
- **Scheduler** — cron and one-shot job support; persistent across restarts (spec 7)
- **Agent YAML config** — declarative agent definition with `pinned_skills`, `memory.scopes`,
  `schedule`, `error_budget` (spec 2)
- **Working memory** — in-memory and Postgres backends for conversation persistence

---

## [0.1.0] — 2026-02-05

### Added
- **EventBus** — typed event definitions (discriminated union in `src/bus/events.ts`),
  layer-enforced publish/subscribe permissions (`src/bus/permissions.ts`)
- **Audit logger** — structured Postgres audit log; every event and agent decision recorded
- **LLM provider interface** — Anthropic implementation; provider-agnostic `AgentRuntime`
- **Agent runtime** — bus-integrated LLM execution with multi-turn conversation support
- **CLI channel adapter** — readline I/O for local development and testing
- **Dispatcher** — routes all inbound messages to the Coordinator agent
- **Prompt injection defense** — sender auth, exfiltration protection, security layer
- **Bootstrap orchestrator** — `src/index.ts` wires all layers in dependency order
- Architecture specs 00–08, contributor docs (CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md)

[Unreleased]: https://github.com/josephfung/curia/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/josephfung/curia/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/josephfung/curia/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/josephfung/curia/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/josephfung/curia/compare/v0.7.2...v0.8.0
[0.7.0]: https://github.com/josephfung/curia/compare/v0.6.1...v0.7.2
[0.6.0]: https://github.com/josephfung/curia/compare/v0.5.0...v0.6.1
[0.5.0]: https://github.com/josephfung/curia/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/josephfung/curia/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/josephfung/curia/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/josephfung/curia/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/josephfung/curia/releases/tag/v0.1.0
