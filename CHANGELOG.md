# Changelog

All notable changes to Curia are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0: minor bumps introduce new capabilities; patch bumps fix bugs. Breaking changes
to public API surfaces (skill manifest schema, `SkillContext` interface, agent YAML schema,
bus event types) are noted explicitly even in the `0.x` range.

---

## [Unreleased]

### Security
- **Dummy credential placeholders** — replaced `curia_dev` in `.env.example` and `docker-compose.yml` defaults with obviously-dummy `your-db-user` / `your-db-password` values to eliminate false-positive secrets scanner alerts (closes #50).

### Fixed
- **Scheduled Jobs page auth** — `/api/jobs` routes now use session-cookie auth (same as KG/identity routes) instead of the global Bearer token hook, so the dashboard can load the page without an `Unauthorized` error.

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

[Unreleased]: https://github.com/josephfung/curia/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/josephfung/curia/compare/v0.7.2...v0.8.0
[0.7.0]: https://github.com/josephfung/curia/compare/v0.6.1...v0.7.2
[0.6.0]: https://github.com/josephfung/curia/compare/v0.5.0...v0.6.1
[0.5.0]: https://github.com/josephfung/curia/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/josephfung/curia/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/josephfung/curia/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/josephfung/curia/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/josephfung/curia/releases/tag/v0.1.0
