# Changelog

All notable changes to Curia are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0: minor bumps introduce new capabilities; patch bumps fix bugs. Breaking changes
to public API surfaces (skill manifest schema, `SkillContext` interface, agent YAML schema,
bus event types) are noted explicitly even in the `0.x` range.

---

## [Unreleased]

### Fixed
- **`calendar-update-event` attendees input type** — declared as bare `array?` which is not a
  valid JSON Schema type; corrected to `object[]?` matching the handler's expected shape
  (`Array<{ email, name? }>`). Caused startup crash after primitive-type validation was added in 0.7.1.
- **Duplicate `extract-relationships` in coordinator `pinned_skills`** — skill appeared twice,
  causing Anthropic to receive two identical tool definitions in the tools array
- **`query-relationships` and `delete-relationship` skill input schemas** — both skills used
  `"string — description"` shorthand in `inputs`, which the manifest parser misreads as the
  type token, producing invalid JSON Schema types that caused Anthropic to reject every chat
  request with a 400 `invalid_request_error`; corrected to `"string (description)"` format
- **`extract-relationships` not available to coordinator** — skill was missing from `pinned_skills`
  in `coordinator.yaml`, so the LLM was instructed to call it but never received the tool definition;
  tool calls silently failed and the agent hallucinated that the skill didn't exist

### Added
- **Contacts CRUD UI** — search, create, edit, and delete contacts directly from the KG web app
- **Contact deduplication** — `DedupService` scores contact pairs using Jaro-Winkler name
  similarity, exact channel identifier overlap (auto-certain), and 3-char name-prefix blocking;
  thresholds: ≥ 0.9 = `certain`, 0.7–0.9 = `probable`
- **On-creation dedup hook** — `createContact()` fires a fire-and-forget background check and
  publishes `contact.duplicate_detected` on the bus when a probable or certain match is found
- **Contact merge** — `ContactService.mergeContacts()` computes a golden record (most-recent-wins
  for scalars, concat for notes, most-restrictive for status, union for identities/overrides) and
  consolidates all data onto the primary contact; `EntityMemory.mergeEntities()` merges the
  corresponding KG nodes (Phase 1: scalar properties + facts; edge re-pointing deferred to Phase 2)
- **`contact-find-duplicates` skill** — read-only full-contact-list scan; `action_risk: "none"`;
  optional `min_confidence` filter (`certain` | `probable`)
- **`contact-merge` skill** — elevated caller required; `dry_run` defaults to `true`; returns a
  `MergeProposal` for review before committing; `action_risk: "low"`
- **Bus events** — `contact.duplicate_detected` and `contact.merged` published by the dispatch
  layer; reason strings are privacy-safe (no PII / identifier values)
- Coordinator workflow guidance for dedup review and weekly scan; both new skills pinned
- **`extract-relationships` skill** — self-classifying two-stage LLM pipeline (haiku classifier gate + sonnet extractor) that extracts entity-to-entity relationship triples from text and persists them to the knowledge graph; coordinator calls it after every message (spec: `docs/wip/2026-04-05-relationship-extraction-design.md`)
- **12 new `EDGE_TYPES`** — personal (spouse, parent, child, sibling), professional (reports_to, manages, collaborates_with, advises, represents), and organisational (member_of, founded, invested_in), extending the existing 7 types
- **`EntityMemory.upsertEdge()`** — idempotent edge persistence with bidirectional duplicate detection; confidence only increases on re-assertion, never decreases
- **`EntityMemory.createEntity()` confidence option** — `CreateEntityOptions.confidence` field so extracted nodes can be seeded at 0.6 (below manually confirmed entities)
- **`query-relationships` skill** — query entity-to-entity relationship edges by entity name, with optional edge type filter; handles zero-match, single-match, and ambiguous (multi-match) cases
- **`delete-relationship` skill** — delete a KG edge by human-readable triple (subject, predicate, object); idempotent and direction-agnostic

### Changed
- **`EntityMemory.upsertEdge()`** — now delegates to `KnowledgeGraphStore.upsertEdge()` for atomic ON CONFLICT DO UPDATE; eliminates the pre-query race condition
- **`KnowledgeGraphStore`** — new `upsertEdge()` method on both Postgres and in-memory backends

### Fixed
- **`kg_edges` uniqueness** — migration 014 adds a bidirectional unique index; concurrent extractions can no longer create duplicate edges for the same (subject, predicate, object) triple

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

[Unreleased]: https://github.com/josephfung/curia/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/josephfung/curia/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/josephfung/curia/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/josephfung/curia/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/josephfung/curia/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/josephfung/curia/releases/tag/v0.1.0
