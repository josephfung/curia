# Changelog

All notable changes to Curia are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0: minor bumps introduce new capabilities; patch bumps fix bugs. Breaking changes
to public API surfaces (skill manifest schema, `SkillContext` interface, agent YAML schema,
bus event types) are noted explicitly even in the `0.x` range.

---

## [Unreleased]

### Breaking Changes

- **Agent YAML schema now enforced at startup** — previously ignored unknown keys and missing required fields now cause a descriptive `process.exit(1)`. Any `agents/*.yaml` that was silently tolerated must be fixed before upgrading.
- **Skill manifest schema now enforced at startup** — same as above for `skills/*/skill.json`. Invalid manifests (missing `version`, `action_risk`, unknown keys) cause startup failure.
- **`MessageRejectedPayload.reason`** extended with `'message_too_large'`, `'global_rate_limited'`, and `'sender_rate_limited'` (bus event type, public API surface) — exhaustive handlers over the `reason` union must add these cases. The payload also gains optional `size` and `limit` fields populated when the reason is `message_too_large`.
- **HTTP 413 for oversized messages** — inbound messages that exceed `channels.max_message_bytes` now receive HTTP 413 (Payload Too Large) instead of 403.

### Security
- **Input validation** — startup validator (`src/startup/validator.ts`) validates `config/default.yaml`, all `agents/*.yaml`, and all `skills/*/skill.json` against JSON Schema (Ajv) at boot time. Invalid configs cause a descriptive `process.exit(1)` before any service initializes (spec §06).
- **Message size limiting** — dispatcher rejects inbound messages exceeding `channels.max_message_bytes` (default 100KB) before routing; rejection is audit-logged as `message.rejected` with causal `parentEventId` and includes the message byte size and configured limit (spec §06).
- **Rate limiting at the dispatch layer** — the dispatch layer now enforces two independent
  in-memory fixed-window rate limits: a global limit (default 100 msg/min across all senders)
  checked before any policy-gate processing to stop aggregate DoS floods early, and a per-sender
  limit (default 15 msg/min) checked after policy gates so blocked/held senders don't consume
  quota for legitimate senders. Excess messages are dropped silently; violations are audit-logged
  as `message.rejected` events with reason `global_rate_limited` or `sender_rate_limited` and
  logged at `warn` level. Both limits and the window duration are configurable in
  `config/default.yaml` under `dispatch.rate_limit`. Completes the rate-limiting item in the
  spec §06 security checklist. Closes #198.

### Added
- **Intent drift detection** — after each burst of a persistent scheduled task, an LLM judge compares the current `task_payload` against the original `intent_anchor`. Tasks that drift with sufficient confidence are paused, and a follow-up `agent.task` is dispatched to the coordinator to notify the CEO (spec §06-audit-and-security.md). Configured via `intentDrift:` block in `config/default.yaml`.
- **`schemas/` directory** — JSON Schema files for agent configs, skill manifests, and `config/default.yaml`. Schemas are legible without TypeScript and can be validated with third-party tools.
- **`channels.max_message_bytes`** in `config/default.yaml` — configures the inbound message size limit (default `102400`).

### Changed
- **Agent and skill loaders** — manual field checks removed; validation is now handled by the startup validator schema.

### Fixed
- **Delegate skill timeout now wired to `expected_duration_seconds`** — the delegate skill
  previously used a hardcoded 90-second timeout regardless of job type, causing long-running
  scheduled specialists (e.g. writing-scout doing many web-fetch calls) to time out and retry
  unnecessarily. `expected_duration_seconds` from the scheduler job is now forwarded through the
  `agent.task` event payload; the runtime injects it as `timeout_ms` on every `delegate` call so
  the specialist gets appropriate headroom without any coordinator.yaml changes. The 90-second
  default is preserved for interactive tasks that carry no scheduler hint. The delegate skill
  outer execution timeout has been raised to 660 s to accommodate jobs up to 600 s. Closes #258.
- **`CreateJobParams` now accepts `expectedDurationSeconds`** — dynamic job creation (HTTP API,
  skills) previously could not set `expected_duration_seconds`; the field was only reachable via
  declarative YAML. `CreateJobParams` now exposes the field with the same validation rules as the
  YAML path (positive finite integer; non-integer/zero/negative values rejected with a clear
  error). Part of #258.
- **Null byte crash in audit logger** — `AuditLogger.log()` now strips U+0000 from all
  string values in event payloads before writing to `audit_log.payload`. Previously, binary
  content returned by `web-fetch` could embed null bytes that PostgreSQL rejects with
  `22P05`, causing the agent task to crash mid-run. Fixes josephfung/curia#257.
- **contact-data-leak false positives** — The `contact-data-leak` deterministic filter rule
  now uses a single-axis policy based solely on recipient trust level, instead of blocking all
  third-party email addresses unconditionally. A third-party email is blocked only when the
  recipient is not trusted. Trusted recipients are the CEO (matched by `CEO_PRIMARY_EMAIL`) and
  any contact with `trustLevel = 'high'` in the contact DB. Trusted recipients may receive
  third-party contact data regardless of how the message was triggered — this correctly handles
  both "CEO asked for Hamilton's email" (user-initiated) and "daily briefing lists meeting
  attendees" (scheduled routine). Closes #210.
  **Breaking changes**: `FilterCheckInput` gained a required `recipientTrustLevel` field.
  `FilterCheckInput`, `EmailSendRequest`, `SignalOutboundRequest`, and `SkillContext` no longer
  have a `triggerSource` field — callers must remove it.

---

## [0.16.0] — 2026-04-10

### Security
- **SPF/DKIM/DMARC sender verification** — email adapter parses `Authentication-Results` headers from Nylas into `senderVerified` on every inbound message; unverified senders logged at `warn`; Coordinator instructed not to act on financial/data/access changes without Signal or CLI confirmation. Closes #195.
- **Anti-injection system prompt hardening** — explicit anti-injection directives added to the Coordinator's system prompt; `messageTrustScore` and raw `risk_score` injected into sender context so the Coordinator can reason about message trustworthiness. Fixed pre-existing bug where the Anthropic provider silently dropped all but the first `role: 'system'` message. Closes #194.
- **PII scrubbing for LLM-facing errors** — error messages routed to the LLM are scrubbed of email addresses, phone numbers, credit card numbers, and SSNs via `src/pii/scrubber.ts`; audit log retains full unredacted errors. Operator-configurable extra patterns via `pii.extra_patterns` in `config/default.yaml`. Closes #197.
- **Pino logger PII redaction** — added `senderId`, `email`, `from`, `phoneNumber` to pino's structured-field redact list as a last-resort safety net against sender identifiers in stdout.
- **Audit log append-only enforcement** — PostgreSQL trigger (`021_audit_log_append_only`) blocks UPDATE/DELETE on `audit_log` except `acknowledged` flips. `EventBus` gains `onDelivered` hook; `AuditLogger` uses it to set `acknowledged = true`. Startup scan warns on unacknowledged rows from prior crashes. Closes #202.
- **Dispatcher fail-closed on audit publish failure** — `contact.unknown` publish wrapped in its own try/catch so a failing audit hook cannot bypass `hold_and_notify`/`ignore` policy. Closes #192.

### Added
- **ADR-014: Capability-tier model routing** — decision to replace per-agent model declarations with a `fast | standard | powerful` tier system, with optional modality flags (`vision`, `large_context`, `reasoning`, etc.). Implementation tracked in linked issue.

### Fixed
- **contact-data-leak false positives** — rule now uses a single-axis trust policy: third-party email is blocked only when the recipient is untrusted. **Breaking:** `FilterCheckInput` gained a required `recipientTrustLevel` field; `triggerSource` removed from `FilterCheckInput`, `EmailSendRequest`, `SignalOutboundRequest`, and `SkillContext`. Closes #210.
- **Outbound content filter `ceoEmail`** — `OutboundContentFilter` and `OutboundGateway` now use `CEO_PRIMARY_EMAIL` instead of `nylasSelfEmail`, fixing false-positive blocks and misdirected blocked-content notifications. Closes #244.
- **Email reply self-routing** — `sendOutboundReply` no longer replies to Curia's own address when Curia sent the prior turn; falls back to first non-self address in the `to` field. Closes #244.

---

## [0.15.0] — 2026-04-09

### Security
- **Secrets isolation audit trail** — `ctx.secret()` calls now emit a `secret.accessed` bus event (skill name, secret name, agentId, taskEventId — never the value). Pino loggers redact `password`, `token`, `secret`, `api_key` fields. Static-analysis test (`secret-manifest-coverage`) fails CI if an accessed secret name is not declared in the skill manifest (spec 06).
- **HTTP API token authentication** — failed auth attempts audit-logged (IP, route, reason); authenticated messages carry `trustLevel: 'medium'` in bus event metadata (spec 06, issue #189).

### Added
- **Message trust scoring** — `messageTrustScore` (0.0–1.0) computed in the dispatch layer from channel trust, contact confidence, and injection risk; attached to every `agent.task` event. Configurable weights under `security.trust_score` in `config/default.yaml` (spec 06).
- **Trust-gated action thresholds** — `trust_policy` config block; Coordinator system prompt enforces per-category minimums: information queries 0.2, scheduling 0.5, data export/financial 0.8.
- **Contact trust fields** — `contact_confidence`, `trust_level`, `last_seen_at` columns on `contacts` (migration 020).
- **Trust score floor** — messages scoring below `security.trust_score_floor` (default 0.2) are held regardless of per-channel unknown-sender policy.
- **Scheduler prior run context** — `last_run_outcome`, `last_run_summary`, `last_run_context` columns on `scheduled_jobs` give agents structured facts about prior runs without replaying raw history (spec 07, migration 019).
- **`scheduler-report` skill** — agents call this at end of a scheduled run to write a summary and continuity context for the next run.
- **`secret.accessed` bus event type** — published by the execution layer; payload carries `skillName`, `secretName`, `agentId`, `taskEventId` — never the resolved value.
- **Bus layer: `llm.call` and `human.decision` event types** — `llm.call` published after every LLM API call (model, tokens, timing, content hashes); `human.decision` published when a human resolves an approval gate (EU AI Act Article 14 context). Both added to `src/bus/events.ts` and `src/bus/permissions.ts` (spec 10, issue #187).
- **Context summarization** — when active conversation history exceeds a threshold (default: 20 turns), oldest turns are condensed into a synthetic summary via LLM and archived. Prevents silent context-window overflow. Migration 018 adds `archived` column to `working_memory` (spec 01).
- **Schedule `agent_id` field** — declarative schedule entries now support `agent_id` to target a different agent. Defaults to source agent for backward compatibility. Startup warning logged on targeting cycles.
- **Intent anchor** — `intentAnchor` on `AgentTaskPayload`; scheduler passes it through; runtime injects `## Original Task Intent` block on every burst to prevent multi-burst drift (spec 01).
- **Spec 06 security completion table** — replaced implementation checklist in `docs/specs/06-audit-and-security.md` with Done/Not Done table; reconciled against open `audit`-labeled issues.
- **Spec 10 audit log hardening completion table** — replaced implementation checklist in `docs/specs/10-audit-log-hardening.md` with Done/Not Done table.

### Changed
- **Sender trust routing** (spec §06): `contact.unknown` event now includes `routingDecision` field (`allow` | `hold_and_notify` | `ignore`), making the unknown-sender audit trail self-contained. The dispatcher now determines routing policy before publishing the event so the intent is always recorded accurately. Closes #192.
- **`unknown_sender: reject` renamed to `unknown_sender: ignore`** — behaviour unchanged (silent drop + audit event); new name clarifies no rejection notice is sent to the sender.
- **`contact.unknown` event** — `channelTrustLevel` is now required (was optional); `messageTrustScore` field added.
- **`completeJobRun`** — writes `last_run_outcome = 'completed'` or `'failed'` on completion.
- **`recoverStuckJob`** — writes `last_run_outcome = 'timed_out'` on recovery.

### Fixed
- **Scheduler history poisoning** — scheduled job runs now use a unique per-run `conversationId`, preventing working memory from loading turns from prior runs (root cause of 2026-04-09 incident where the daily schedule job called `scheduler-create` instead of executing its task).
- **Declarative job upsert** — switched from `ON CONFLICT ON CONSTRAINT` (requires named constraints) to column-based conflict syntax matching the `scheduled_jobs_declarative_uq` partial unique index.

---

## [0.14.0] — 2026-04-08

### Added
- **Conversation checkpoint pipeline** — `ConversationCheckpointProcessor` fires after 10 min inactivity per conversation–agent pair; fans out to background memory skills and advances a per-(conversationId, agentId) watermark in `conversation_checkpoints`. Adds migration 017. **Breaking change:** `conversation.checkpoint` added to the bus event discriminated union.
- **`extract-facts` skill** — extracts single-entity attribute facts (home city, job title, preferences, etc.) from transcripts and persists as `fact` nodes via `EntityMemory.storeFact()`; runs at each conversation checkpoint alongside `extract-relationships`. Closes #151.
- **`KnowledgeGraphStore.upsertNode()`** — idempotent node creation; raises confidence on conflict. Returns `{ node, created }`.
- **`EntityMemory.updateNode()`** — new public method; label changes that collide with an existing node of the same type automatically merge nodes. Returns `{ node, merged }`.
- **`kg_nodes` uniqueness constraint** — `idx_kg_nodes_unique` on `(lower(label), type) WHERE type != 'fact'` prevents future duplicate entity nodes.
- **Spec 11 implementation status** — added Implementation Status section to `docs/specs/11-entity-context-enrichment.md`.

### Changed
- **`extract-relationships`** — moved from per-message LLM tool loop to conversation checkpoint pipeline; runs once per conversation–agent pair after 10 min inactivity.
- **`EntityMemory.createEntity()`** — returns `{ entity, created }` instead of `KgNode`; delegates to `upsertNode` for race-safe creation. **Breaking change** for callers (all internal call sites updated).
- **`mergeEntities` Phase 2** — re-points secondary entity edges to primary and deletes the secondary node (was previously deferred).
- **Spec index** (`docs/specs/00-overview.md`) — added Status column and rows 12–16; unified Scope notes with README Area column.
- **README** — removed redundant Project Status table; status consolidated in spec index.

### Fixed
- **`ValidatedFactData.temporal` misleading type** — replaced `temporal: TemporalMetadata` (which included `createdAt`/`lastConfirmedAt`) with a narrower `provenance: { confidence, decayClass, source }`. The store always stamps its own timestamps on INSERT; the old type falsely implied the caller-set timestamps would survive to the persisted node. Closes #183.
- **Coordinator confabulation** — removing `extract-relationships` from the coordinator's LLM tool loop eliminated empty-text turns that triggered confabulated "I already provided my response" replies in Signal group chats and the web UI.
- **KG node deduplication** — one-time migration deduplicates existing `kg_nodes` rows with matching `(lower(label), type)`, re-pointing edges and contacts to canonical nodes before removing duplicates.

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

[Unreleased]: https://github.com/josephfung/curia/compare/v0.16.0...HEAD
[0.16.0]: https://github.com/josephfung/curia/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/josephfung/curia/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/josephfung/curia/compare/v0.12.1...v0.14.0
[0.12.1]: https://github.com/josephfung/curia/compare/v0.11.0...v0.12.1
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
