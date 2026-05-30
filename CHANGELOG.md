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

- **Console static asset auth** — `@fastify/static` v9 with `wildcard:false` registers an individual Fastify route per file in `consoleDist`, so `routeOptions.url` returns the exact asset path (e.g. `/assets/index-CU1g6HdR.js`) rather than `/*`; the old bypass list missed these routes and every static asset returned 401. Auth hook now skips bearer auth for all non-`/api/` routes.

### Added

- **Knowledge Graph view** — new `/kg` console page with Cytoscape/fcose canvas, node search sidebar, in-place neighborhood expansion, color-by-type/sensitivity/decay toggle, node detail drawer, and URL-persisted `?q=`/`?node=` state; removes legacy `createUiHtml()` and `/old` routes. (#780)
- **Chat view improvements** — agent replies now render markdown (bold, lists, code, italics) via server-side conversion; messages show timestamps; history hydrates from `working_memory` on reload (persisted via localStorage); scrolling up loads older pages. (#175)
- **Scheduled Jobs view** — new `/jobs` console page with CRUD, status filters, and resume action for suspended jobs; removes legacy nav item. (#782)
- **Tasks view** — new console page at `/tasks` with full CRUD, sortable columns, and status filter chips; legacy `/old/tasks` removed. (#783)
- **Contacts view** — new console page at `/contacts` with full CRUD and editable trust level; legacy `/old/contacts` removed. (#781)

### Changed

- **`/api/kg/contacts`** — GET and PATCH responses now include `trustLevel`; PATCH accepts `trustLevel` to update it via `ContactService.setTrustLevel`.

### Fixed

- **Migration 015 collision** — merged `015_create_bullpen` and `015_scheduler_resilience` into a single `015_bullpen_and_scheduler_resilience` to resolve a duplicate-prefix conflict.
- **HTTP session persistence** — hashed tokens written to Postgres and restored on startup; browser auth survives restarts. (#748)
- **`bullpen`** — `post` is now idempotent when `source_message_id` is provided; returns existing thread on duplicate. (#708)

### Changed

- **`ceo-inbox`** — restricted polling schedule from 24/7 to 6am–11pm local time, reducing idle LLM calls during dead hours.

### Added

- **Wizard console port** — onboarding wizard at `/setup` with first-run redirect; removes legacy KG wizard overlay. (#751)

- **Autonomy console view** — Autonomy settings ported to the new console app at `/settings/autonomy`; includes the score display, live-preview slider, reason field, save, and paginated history. Removed the Autonomy view from the legacy `/old` UI. (#752)

- **Chat view** — single-stream `/chat` route with live SSE status events, optimistic UI, and `/old/chat` redirect. (#779)

- **Console app scaffold** — new `apps/console/` Vite + React + TanStack Router app; Fastify serves the static bundle at `/` with SPA fallback; auth-gated dashboard placeholder; design-system components (Sidebar, Topbar, Icons) copied and converted to TypeScript. `pnpm dev` starts both the backend and the Vite dev server concurrently. (#750)

### Fixed

- **Console root path auth bypass** — `GET /` now skips bearer auth; `@fastify/static` registers it as a distinct route when `wildcard: false`, so the `/*` bypass added in #769 did not cover it.
- **`file-parse` PDF extraction** — call the v2 `PDFParse` class; the v1 API was throwing on every PDF, misreported as "image-only". (#770)
- **Migration `016_kg_node_uniqueness`** — Step 4 now checks for pre-existing contacts on canonical KG nodes before re-pointing, preventing a duplicate-key violation on `idx_contacts_kg_node_unique` when a canonical node already had its own contact row.
- **Console Vite dev proxy** — `/old` and the four cytoscape assets (`cytoscape.min.js`, `layout-base.js`, `cose-base.js`, `cytoscape-fcose.js`) are now proxied to Fastify in the Vite dev server; without this the Vite SPA intercepted `/old` requests and the legacy UI was unreachable in dev. (#750)

### Changed

- **Legacy web UI** — moved from `/` to `/old` and `/old/*`; `/` now returns a 404 placeholder pending the new console app. (#749)

### Security

- **HTML sanitization** — hardened `htmlToText`, `stripHtmlTags`, and `htmlToPlainText` closing-tag regexes and tag-strip loops against bypass attacks; added `<script>`/`<style>` content stripping to `ceo-nylas-client.ts`. (CodeQL #55, #61–68)
- **Insecure temp file** — `file-parse` tests now create a unique `mkdtemp` subdirectory under `/tmp/curia-tempfiles/` instead of a fixed path. (CodeQL #69, #70)
- **ip-address XSS** — bumped transitive `ip-address` from 10.1.0 to 10.2.0 via lockfile refresh and added a defensive `>=10.1.1` override. (CodeQL #54)
- **CodeQL false-positive** — disabled `js/incomplete-multi-character-sanitization` in `codeql-config.yml`; all flagged sites use a loop-until-stable pattern the rule cannot model, making every alert a false positive; inline suppression comments were ineffective. (CodeQL #71–92)

### Added

- **`pnpm run setup`** — single-command setup for fresh clones; run `pnpm run setup`, not `pnpm setup`. (#755)

### Fixed

- **Declarative scheduler jobs** — include `source_agent_id` in the persisted identity so two specialist agents can declare identical schedules targeting the same agent without silently collapsing into one row. (#231)
- **Trivy Docker Image Scan** — add `onlyBuiltDependencies: ["esbuild"]` to `package.json` so pnpm 11's build-script approval check doesn't abort the Docker build cold.
- **Dockerfile esbuild build** — include `pnpm-workspace.yaml` in the build-stage `COPY` so `allowBuilds` reaches pnpm inside Docker.

## [0.31.1] — 2026-05-26 — "Janet"

> **Janet** *(The Good Place, 2016, Michael Schur)* — the neighborhood's vast informational assistant: appears when summoned, answers with total knowledge of every resident, performs only the function asked, never lies about what she did. v0.31.1 reshapes Curia's agents along the same lines — they know who the principal is at bootstrap, stay on the task they were scheduled for, don't retry into uncertainty, and leave an honest audit trail of every wire-level send.

### Security

- **`outbound.delivered`** — canonical audit event from the outbound gateway after every successful email or Signal send. (#729, spec 06 / 10 / 15)

### Added

- **`${principal_contact_id}` placeholder** — agent system prompts reference the principal's contact ID directly; bootstrap-resolved, opt-in. (#716, spec 02 / 09)
- **`meeting-debrief` idempotency guard** — `config-store` key `prompted:<eventId>` blocks duplicate Bullpen threads. (#724, spec 17)
- **`calendar-list-events` optional `contactId`** — scheduled agents and the principal can look up calendars by contact UUID.

### Changed

- **Email reply quoting** — HTML `<blockquote>` with attribution headers, sanitized; natural agent-response replies now included. (#720, #734)
- **`scheduler-report`, `scheduler-list`** — sensitivity demoted to `normal`; scheduled agents can persist tick state without elevation.
- **`ceo-inbox-read`** — timeout raised 15 s → 30 s to absorb Nylas latency spikes.

### Fixed

- **`bullpen`** — `post`/`reply` fire-and-forget `agent.discuss`; slow subscribers no longer time out the handler. (#721, spec 03)
- **Scheduler task drift** — coordinator's scheduler runs are scope-restricted; ambient context isn't an action trigger. (#730, spec 07)
- **`calendar-list-events`** — non-UUID caller `contactId` returns a clear error instead of a raw Postgres parse failure. (#723)
- **`calendar-list-events` authorization** — `contactId` override uses trusted originator metadata, not `ctx.caller` shape.
- **`meeting-debrief` calendar lookups** — passes `contactId: ${principal_contact_id}` explicitly, fixing cron-context failures.
- **`reply-quote`** — Outlook VML CSS no longer leaks into the quoted body as visible text. (#733)

### Removed

- **Shipped WIP design/plan docs** — 2 files in `docs/wip/` removed; spec 09 and spec 02 are now authoritative.

## [0.31.0] — 2026-05-26 — "TARS"

> **TARS** *(Interstellar, 2014, Christopher Nolan)* — the faintly wry robot who carried Cooper's messages across the tesseract back to Murph on Earth, with configurable parameters and his own quiet initiative. v0.31 is built around the same shapes: a delegation-aware context bridge that routes replies back to whichever agent started the thread, Curia's first proactive agent (meeting debrief), externalized timeouts you can tune, and a request-clarification skill for pausing mid-task to check in.

### Added

- **Meeting debrief agent** — Curia's first proactive specialist: scans the calendar every 5 minutes for recently-ended external meetings, prompts the CEO for takeaways via Signal (Bullpen-through-coordinator), and executes follow-up actions from the CEO's notes (spec 17, #384).
- **Context bridging v2** — dedicated `outbound_context` Postgres table replaces working-memory memos; every send registers an entry, the dispatcher injects an `[ACTIVE OUTBOUND CONTEXT]` block on inbound, the coordinator-only `context-bridge-release` skill closes threads explicitly, and a periodic cleanup job keeps the table bounded. (#615, #679, #685, ADR-019)
- **`request-clarification` skill** — specialists can pause mid-task to ask the CEO a clarifying question; the runtime short-circuits the tool-use loop and the DelegateHandler returns a resume_token for seamless re-delegation. (#706)
- **Multi-turn research conversations** — research-analyst pauses mid-research, the coordinator routes the question to the CEO, and re-delegates automatically when the CEO replies. (#611)
- **Turn budget injection** — every agent receives its exact turn limit in the system prompt as a planning constraint, with anti-retry, error-acceptance, and structured-output guidance; proximity warning widened from 3 to 5 turns remaining. (#689)
- **`embedding.call` telemetry** — `EmbeddingService` publishes cost and token-count events alongside `llm.call` entries; `text-embedding-3-small` added to the model registry. (#654)
- **Declarative job originator** — YAML-defined scheduled jobs are stamped with a `systemRole: 'system'` originator at startup, distinguishing operator-configured work from principal-initiated and agent-decided tasks. (#558)
- **`deepseek/deepseek-v4-pro`** — added to the model registry so it can be used as a standard-tier model in deployment config.

### Changed

- **`ceo-inbox` URGENT alerts** — now route through the coordinator via Bullpen rather than calling `signal-send` directly; CEO replies to alerts route back to the inbox agent through context bridging. (#616)
- **Email reply quoting** — `email-reply`, `email-draft-save`, `email-send`, and `ceo-inbox-draft-reply` now append the quoted original message body below the reply, matching standard email-client behaviour. (#673)
- **Delegate and scheduler timeouts externalized** — `delegate.defaultTimeoutMs` (default 90 s) and `scheduler.defaultExpectedDurationSeconds` (default 600 s) are config keys with startup validation; deployments tune them in `local.yaml` without patching the runtime. Coordinator and contacts scheduled tasks bumped to reflect higher standard-tier latency. (#713)
- **Multi-turn clarification protocol** — moved from ~145 lines of hand-written prompt convention to the code-backed `request-clarification` skill; coordinator and research-analyst prompts shrink by ~105 lines combined.
- **`file-parse` access relaxed** — `allowed_callers` restriction removed; the skill is now invocable by any agent. Custom agents that parse files (e.g. expense trackers reading receipt attachments) were previously blocked at runtime despite having the skill pinned. (#681)
- **`file-parse` accepts `temp_file_url`** — alternative to `content_base64`, bridging the gap with `ceo-inbox-download-attachment` for files staged in `CURIA_TEMPFILE_DIR`. (#709)

### Fixed

- **Delegated specialist auth and identity** — `ctx.caller` is synthesized from `taskMetadata.originator` when `senderContext` is absent (#710); `contact-merge` stale guard removed; `contact-grant-permission` falls back to originator contactId; `contact-lookup` returns status and identities and documents the `by: "channel"` input. (#711)
- **Authorization boundary hardening** — role names lowercased before config lookup (so `'Spouse'` matches `spouse`); effective trust is `max(channelTrust, contactTrustLevel)` so confirmed contacts with explicit `trust_level` grants aren't downgraded by the channel floor (the CEO can now request own calendar via email); `trust_level_defaults` fallback for free-text roles; unknown trust values throw and degrade safely instead of silently collapsing; `trust_level_defaults` validated at startup. (#707)
- **Email case sensitivity** — `linkIdentity` normalizes to lowercase; `resolveByChannelIdentity` is case-insensitive; migration 044 adds a functional unique index on `LOWER(channel_identifier)`.
- **Memory write rate limit** — `storeFact` source keys now match the format `AgentRuntime.resetRateLimit()` clears; per-task counters scope and clean up correctly instead of accumulating globally. Affected: `config-store`, `memory-store`, `extract-facts`, `template-doc-request`.
- **`workspace-mcp` tool tier** — upgraded to `complete`; `create_sheet` and `append_table_rows` now available. (curia-deploy#65)
- **`ceo-inbox-update-folders`** — empty-folders guard prevents accidental folder wipes when Nylas omits `folders` from the PUT response. (#596)
- **`ceo-inbox-draft-reply`** — fails on empty `from` rather than silently creating a draft addressed to `unknown`. (#598)

### Security

- **`qs` pinned to ≥ 6.15.2** — closes CVE-2026-8723 (DoS via `qs.stringify` crash on null/undefined in comma-format arrays).
- **Governance skill caller restrictions** — `set-autonomy`, `approve-action`, `deny-action`, `dismiss-action`, and `delegate` declare `"allowed_callers": ["coordinator"]`; prevents rogue privilege escalation and delegation chains from specialist agents. (#681)
- **`package-lock.json` removed** — gitignored alongside `yarn.lock`; pnpm is the source of truth, silencing spurious Dependabot alerts. (#30, #32, #33)

### Removed

- **v1 `context-memo`** — write path and module deleted; context bridging now runs exclusively through `OutboundContextService`. (#615)
- **Shipped WIP design/plan docs** — 9 files in `docs/wip/` removed; spec 11, spec 17, and ADR-019 are now authoritative.

### Documentation

- **Spec sync** — specs 02–09, 11, 15, and 17 updated with v0.31 deltas; spec 11 gains a major Outbound Context Bridge section; ADR-019 records the v1 → v2 architectural decision; dev guides (`configuration.md`, `adding-a-skill.md`, `smoke-tests.md`) updated; public docs at meetcuria.com synced with the new agent, skills, capability, and config blocks.

---

*after the meeting*
*the thread holds open, waiting*
*for whatever next*

---

## [0.30.0] — 2026-05-22 — "Kaylee Frye"

> **Kaylee Frye** *(Firefly, 2002, Joss Whedon)* — Serenity's mechanic, who keeps a ship flying on spare parts, intuition, and a refusal to waste anything. She routes around problems, trusts the parts she knows, and gets more out of less than anyone thought possible. This release adds multi-model routing to stretch every dollar, downgrades agents to cheaper tiers where they don't need the power, and tightens security without adding overhead.

### Added

- **OpenRouter provider** — optional multi-model routing for Gemini Flash, DeepSeek V3, and GPT-4o via `OPENROUTER_API_KEY`. (#379)
- **Model registry** — centralised pricing, context windows, and capabilities in `ModelRegistry`; cost estimation and token tracking delegate to registry data instead of hardcoded values. (#556)
- **Contact auto-promotion** — provisional contacts promoted to confirmed automatically when Curia sends them a message, the CEO has emailed them, or the CEO accepted a calendar event with them; daily 8 AM sweep reconciles. (#633)
- **`contact-list` filters** — new `status` and `limit` parameters for direct DB-level filtering; eliminates entity-context timeout on status queries. (#644)
- **`allowed_callers` enforcement** — skills can restrict invocation to named agents via `allowed_callers` in `skill.json`; validated at startup, enforced before autonomy gates. (#618)
- **`infraLlm` capability** — constrained LLM access (`classify` and `extract` only) for infrastructure skills, replacing raw SDK usage with telemetry-emitting `LLMProvider` calls. (#637)
- **Trivy scanning** — filesystem scan (npm deps + secrets) on every PR; Docker image scan weekly. (#563)

### Changed

- **`model_routing` config** — removed tier `provider` field; renamed `autonomy_scoring.model` to `model_tier`. Provider is now inferred from the model registry. *(Public API surface change.)*
- **Agent tier downgrades** — contacts, calendar, and research-analyst moved from `standard` to `fast` tier for cost savings. (#648)
- **Time context injection** — extended from coordinator-only to all agents; specialists now receive date and time on every task turn. (#55)
- **Skill LLM abstraction** — `extract-facts`, `extract-relationships`, `file-parse` migrated from raw Anthropic SDK to `LLMProvider` via SkillContext. (#556)

### Fixed

- **`ceo-inbox` model tier** — reverted from `fast` to `standard`; Haiku produced incorrect Unix timestamps that blinded inbox triage.
- **`email-list` unread filter** — `is:unread` now embedded in search string when both `search` and `unread_only` are set; Nylas v3 was silently dropping the filter.
- **`config-store`** — `retrieve` falls back to `properties.key` on label mismatch (#660); `store` surfaces rejection status instead of reporting success (#661).
- **Declarative job cleanup** — `loadDeclarativeJobs` auto-cancels stale YAML schedules after cron changes or removals. (#640)
- **`ceo-inbox-list`** — normalize `DRAFTS` folder alias to `DRAFT` for Gmail API compatibility.
- **`NylasClient.listMessages`** — suppress conflicting params when `searchQueryNative` is set; fixes HTTP 400 errors. (#646)
- **Provider registry routing** — shared LLM consumers (WorkingMemory, DriftDetector, AutonomyScoringPass, ExecutionLayer) now resolve from `providerRegistry`, not the Anthropic singleton. (#646)

### Security

- **HTML sanitizers** — loop-based stripping replaces single-pass regex in `html-to-text`, `file-parse`, and `held-messages-list`; resolves 6 CodeQL alerts. (#591)
- **Non-root container** — production image runs as `curia` user. (#607)
- **Branch protection** — `main` requires PR review and passing status checks. (#567)

---

*spare parts, new roads —*
*the engine hums on less now;*
*trust what you can see.*

---

## [0.29.0] — 2026-05-19 — "Naomi Nagata"

> **Naomi Nagata** *(The Expanse, 2011, James S.A. Corey)* — chief engineer of the Rocinante: she keeps disparate systems integrated, monitors ship health, and is always the first to notice when something is about to break. This release consolidates the CEO inbox into core, adds self-monitoring alerts for broken and stuck jobs, and hardens the engineering foundation with security scanning and proper binary file handling.

### Added

- **`ceo-inbox` agent and 9 skills** — migrated from `curia-deploy/custom/` into curia core; now covered by CI and type-checked against real types. (#592)
- **`TempFileStore` platform capability** — capability-gated service that writes binary buffers to a noexec tmpfs mount and returns `file://` URLs; skills declare `tempFileStore` in their manifest to receive `ctx.writeTempFile()`. TTL sweep and startup purge ensure files never linger. (#624)
- **Email attachment support** — metadata surfaced in email skills with human-readable summaries; download skills write raw bytes to TempFileStore for binary-correct Drive uploads. (#622, #624)
- **Email folder management** — `email-label`, `email-list-folders`, `email-create-folder`, and `email-mark-read` skills.
- **`SuspensionNotifier`** — emails CEO when a scheduled job suspends after consecutive failures, bypassing the LLM pipeline for reliability during outages. (#538)
- **`RecoveryNotifier`** — emails CEO when the watchdog auto-recovers a stuck job, including stuck duration and timeout threshold. (#207)
- **Alias-aware entity resolution** — `EntityMemory.search` checks aliases before vector search; `mergeEntities` unions aliases from both nodes; new atomic `addAlias` on `KnowledgeGraphBackend`. (#536)
- **Principal bypass** — CEO-originated tasks skip autonomy Gates A and B. (spec 14)

### Changed

- **Dispatcher email metadata refactor** — extracted parsing and preamble builders into standalone `email-metadata.ts` module. (#465)
- **Coordinator inbox delegation** — CEO inbox queries now delegate seamlessly to the ceo-inbox specialist.

### Fixed

- **Attachment-to-Drive pipeline** — four compounding bugs that prevented downloaded email attachments from uploading correctly to Google Drive (base64 encoding corruption, file allowlist blocking, skill pinning, output truncation) resolved by routing through TempFileStore. (#622, #624)
- **`held-messages-process`** — identify action now promotes contacts to `confirmed` before replaying; provisional contacts no longer re-held.
- **`ceo-inbox-search`** — corrected Nylas v3 search parameter; suppresses incompatible filters during search.
- **`ceo-inbox` ACTIONABLE archive** — emails now reliably archived after specialist handoff.
- **Self-email loop filter** — inbound poll rejects self-sent messages via folder, sent-ID, and normalized-address checks. (#37)
- **Calendar write timestamps** — `calendar-create-event` and `calendar-update-event` now return local timezone timestamps, matching the read-path handlers. (#369)

### Security

- **Semgrep CE scanning** — pattern-based SAST on every PR and weekly schedule; SARIF results in the Security tab. Initial triage suppressed 28 false positives. (#562)
- **Per-route rate limiting** — auth endpoints capped at 10 req/min per IP; KG and health endpoints at 60 req/min. (#580)
- **HTML sanitization** — 15 CodeQL HTML-injection alerts resolved. (#581)
- **Gitleaks secret scanning** — blocks merge if secrets are detected. (#560)
- **CodeQL static analysis** — weekly JS/TS security scanning; upgraded to Action v4 + Node.js 24 runner. (#561, #582)

---

*the ship runs itself —*
*alerts hum where silence hid;*
*the engineer sleeps.*

---

## [0.28.0] — 2026-05-14 — "Thufir Hawat"

> **Thufir Hawat** *(Dune, 1965, Frank Herbert)* — the Mentat Master of Assassins for House Atreides. A human computer who weighs every variable, tracks every cost, and routes intelligence through strict chains of command. His value is knowing exactly where resources are spent and what each capability costs — and never allocating more than the mission requires.

### Added

- **LLM token tracking** — every Anthropic API call publishes a structured `llm.call` bus event with token counts, prompt-cache breakdown, estimated cost, and content fingerprints — enabling per-agent attribution. (closes #326)
- **Context budget** — token-aware context assembly with per-tier budgeting, automatic estimation, and `context.budget` events that flag which tiers were dropped. (#24)

### Changed

- **Model routing** — agents declare `model.tier` instead of a specific model; operator maps tiers centrally (ADR-014). (#260)
- **Cache token fields** — `LLMUsage` and `LlmCallPayload` extended with `cacheCreationInputTokens` and `cacheReadInputTokens`, previously silently dropped.
- **`security.trust_thresholds` config** — action thresholds moved from hardcoded coordinator text to config; startup fails if missing or malformed.
- **Compiled security context block** — four security sections extracted from `coordinator.yaml` into a runtime-injected `${security_context_block}`, always present.

### Fixed

- **`TaskOriginator` through delegation boundaries** — originator now propagates through scheduler, delegate, and bullpen so `isPrincipalOriginated()` works correctly. (closes #504)
- **Declarative job drift detection** — YAML-defined scheduled jobs now support `intent_anchor`, enabling drift detection previously silently skipped. (closes #416)
- **Google Workspace tools** — doc creation, editing, formatting, sharing, and Drive tools reliably available without manual discovery. (#497)
- **`extract-facts`** — programming errors in the per-fact loop now re-throw instead of being silently swallowed. (#493)

### Removed

- **`trust_policy` config key** — dead config removed; replaced by `security.trust_thresholds`.

---

*count before you speak —*
*the right mind for every task;*
*cost writes its ledger.*

---

## [0.27.0] — 2026-05-12 — "Gerty"

> **Gerty** *(Moon, 2009, dir. Duncan Jones)* — the AI station manager aboard Sarang lunar base. Unobtrusive, precise, deeply loyal. Remembers everything, knows the identity of everyone under its care, and manages complex operations without fanfare. When things get uncertain, Gerty resolves them quietly. Nothing important gets forgotten.

### Added

- **Contact Specialist agent** — new dedicated agent for all contact-domain work: briefings, CRUD, deduplication, and entity resolution. The coordinator now delegates rather than handles contact tasks directly. (#498)
- **Calendar Specialist agent** — new dedicated agent for all scheduling work: finding time, resolving conflicts, creating events, and drafting scheduling emails. Multi-party, timezone-aware, preference-sensitive. (#499)
- **Fuzzy entity resolution** — the knowledge graph now resolves near-matches by semantic similarity, preventing duplicate nodes from name variants ("Darlise" / "Darlise Restaurant"). Confirmed matches are stored as aliases for instant future resolution. (#467)
- **Decay warnings** — important KG nodes are flagged before archival rather than silently deleted. High-sensitivity or highly-connected nodes enter a 7-day hold-back window; the coordinator nudges the CEO to confirm before anything is lost. (#280)
- **`file-parse` skill** — parses CSV, PDF, HTML, and images into structured data. CSV is deterministic; images use vision; PDFs and HTML use text extraction with optional LLM structuring.
- **Identity status** — channel identities now carry an `active`/`defunct`/`bounced` status, separate from `verified`. Outbound routing and contact lookup both prefer active identities. (#377)
- **Startup readiness gate** — Curia refuses inbound messages until a principal contact is configured.
- **Research-analyst memory** — the research analyst can now read from and write to the knowledge graph; important findings about known entities persist across sessions.

### Changed

- **Specialists absorb their domains** — the coordinator sheds ~200 lines of prompt text and 26 pinned skills as Contact and Calendar specialists take full ownership of their areas.
- **Contradiction auto-resolution** — conflicting facts are now resolved automatically by confidence: lower-confidence incoming facts are rejected; higher-confidence ones update in place with the prior value preserved in an audit trail. Equal-confidence contradictions still escalate for human review.
- **Principal identity is database-driven** — CEO identity is now `system_role='principal'` on the contacts table instead of env vars and config fields. *(Public API change: `TaskOriginator` replaces `ceoInitiated: boolean`; use `isPrincipalOriginated()`.)*
- **`config-store` replaces knowledge-* skills** — `knowledge-company-overview`, `knowledge-meeting-links`, `knowledge-travel-preferences`, `knowledge-loyalty-programs` replaced by `config-store` with equivalent namespaces.

### Fixed

- **`file-parse`** — ESM import of the CJS-only `pdf-parse` package now works; the skill was failing silently in production.
- **Google Drive sharing** — the coordinator correctly surfaces Drive management skills instead of claiming it cannot share files.
- **Entity-context email resolution** — known contacts referenced by email address in CC'd threads now receive full KG context. (#461)

### Removed

- **`file-reader` and `file-writer` skills** — general filesystem access from LLM agents is a prompt-injection risk; removed from spec scope.
- **Template scheduling skills** — `template-meeting-request`, `template-reschedule`, and `template-cancel` deleted; the Calendar Specialist composes scheduling emails directly.
- **`knowledge-*` static skills** — see `config-store` above.

---

*know your own domain —*
*names blur into the known shape;*
*memory holds true.*

---

## [0.26.0] — 2026-05-10 — "In the Record"

### Added

- **Contact confidence scoring pipeline** — `contact_confidence` is now updated on each qualifying event (inbound message, outbound message, CEO trust grant, verified identity pairing) rather than being set by fiat. Supports incremental updates per event and full-recompute on demand with a convergence guarantee. Replaces the `setTrustLevel('high')` band-aid in the outbound gateway. (spec 06, #460)
- **`contact-register` skill** — agents that read channels directly (e.g. the ceo-inbox agent) can now call this skill to resolve or create a contact, update `last_seen_at`, trigger a confidence delta, and emit a `contact.resolved` bus event. (#485)
- **MCP `fixed_inputs`** — MCP server entries in `skills.yaml` now accept a `fixed_inputs` map that binds constant parameter values at startup. Values are resolved from env vars or literals, stripped from tool schemas (invisible to agents), and merged into every `callTool` invocation. Useful for per-server identity data (e.g. which Google Workspace account to use) without polluting the agent's input space. (#432)
- **Non-threaded channel context bridging** — the dispatch layer writes outbound context memos to working memory after each response on non-threaded channels (Signal, CLI, HTTP) and injects them as a preamble when the user replies. Eliminates "what are you referring to?" on Signal follow-ups. The coordinator gains a channel-agnostic clarification gate for reply-shaped messages without context. (#431)
- **Thread-participants block** — inbound email tasks now include a structured From / To / CC block in LLM context, with Curia's own address shown as "you", giving the coordinator unambiguous context on CC'd threads.

### Changed

- **`email-reply` defaults to reply-all** — pass `cc: ""` to reply to sender only, or a comma-separated list to override recipients explicitly. `sendOutboundReply` (implicit reply path) now includes CC recipients by default, filtering self and the primary To recipient. `SkillContext` gains `selfEmail?: string` so skills can filter Curia's own address from CC lists. *(Public API surface change.)*
- **Bullpen context refresh** — `AgentRuntime` re-fetches pending Bullpen threads before every `chatWithRetry` call, not just at task start. Replies and closures that arrive mid-task are visible to the model on the next iteration. (#213)
- **`contact.resolved` bus event** — `sourceLayer` widened from `'dispatch'` to `'dispatch' | 'execution'`; `createContactResolved()` factory accepts an optional `sourceLayer` parameter (defaults to `'dispatch'`). `IdentitySource` gains new value `'agent_called'`. *(Public API surface changes.)*
- **Google Workspace identity** — removed the `channel_accounts.google_workspace` config block and `googleWorkspaceAccounts` system-prompt injection; account identity now supplied via `fixed_inputs` on the MCP server config entry. (#432)

### Fixed

- **Trust floor confirmed-contact exemption** — confirmed contacts with `contact_confidence=0` and no explicit `trust_level` override are no longer incorrectly held by the trust floor; the floor exempts all contacts with `status='confirmed'`.
- **`extract-facts` reliability** — rate-limited facts now break the per-fact loop immediately and log at `error` level instead of silently collapsing into the contradiction warn log; variable declarations moved before the try block so the catch can always reference `subject` and `attribute`. (#470)

### Removed

- **Google Workspace prompt injection** — `googleWorkspaceAccounts` system prompt block, `channel_accounts.google_workspace` config schema, and all related types. Account identity moves to `fixed_inputs`. (#432)

---

*each exchange is logged —*
*confidence built from the count;*
*the record holds true.*

---

## [0.25.1] — 2026-05-07 — "Clean Lines"

### Removed

- **Observation mode** — removed the `observationMode` flag, preamble injection, outbound suppression, and all 12+ branch points across channel, dispatch, agent, and execution layers. CEO inbox monitoring is now a dedicated skill domain in curia-deploy, not a channel concept. Eliminates the cross-grant Nylas ID bugs and identity confusion that plagued v0.24.
- **`email-triage` agent** — deleted. Triage moves to the dedicated `ceo-inbox` agent in curia-deploy.
- **`outbound_policy` / `draft_gate`** — removed from config types, validation, schema, and email adapter. All channel accounts now send directly (autonomy-gated).
- **`ObservationTriageCompletedEvent`** — removed from bus events and permissions.
- **`triage_classification`** — removed from `email-draft-save` and `email-reply` skill inputs.

### Changed

- **Coordinator email instructions** — simplified. Direct inbound replies use the response content; CC'd emails use `email-reply` with the preamble's Message ID. No observation-mode delegation or identity branching.

### Fixed

- **CI pnpm 11 compatibility** — pinned pnpm 11, removed stale `onlyBuiltDependencies` config, and applied esbuild workaround for the CI workflow.

---

*old branches pruned away —*
*one voice, one mailbox, clear.*
*the lines hold their own.*

---

## [0.25.0] — 2026-05-05 — "By Your Leave"

### Added

- **Approval workflow** — when a skill is blocked by the autonomy gate, the execution layer now creates an approval request and notifies the CEO rather than hard-failing. Four new CEO-facing skills: `approve-action`, `deny-action`, `dismiss-action`, `list-pending-actions`. Stale requests expire hourly via `approval-expiry-sweep`; a daily 8 AM digest summarises outstanding requests each morning via `pending-actions-digest`. Implements ADR-018. (#427, #428, #429)
- **Autonomy Phase 2 hard gates** — the execution layer now enforces `action_risk` thresholds against the live score at invocation time. A blocked skill emits `autonomy.skill_blocked`, returns an advisory failure describing the required score, and routes to the approval workflow above. `OutboundGateway.send()` independently blocks direct sends when score < 70, leaving drafts as the fallback. (#147)
- **Autonomy Phase 3 automatic score adjustment** — a daily `AutonomyScoringPass` runs as a DreamEngine sibling pass, scoring recent actions on Competence / Commitment / Compatibility and nudging the autonomy score ±5. Deterministic scoring for approval outcomes; LLM-as-judge for task success/failure. Guards: 30-action minimum, 7-day CEO cooldown, 20% error-rate cap. `get-autonomy` now surfaces `lastSetBy`, trend direction, and scored action count. (#148)
- **Autonomy web UI** — dedicated Settings page to view the current score, trend direction, and paginated change history. New REST endpoints: `GET /api/autonomy`, `PUT /api/autonomy`, `GET /api/autonomy/history`. (#409)
- **`send-draft` skill** — allows the CEO to instruct Curia to send a previously saved Nylas draft. Requires a CEO-originated task context; bypasses the autonomy gate via `humanApproved: true` while preserving blocked-contact and content-filter checks. Implements ADR-017. (#414)
- **PII outbound redaction** — `PiiRedactor` sits between agent responses and channel delivery, scanning for credit cards, phone numbers, SSNs, and email addresses. Redaction is channel-aware: per-channel allow lists in config control which patterns pass through. CEO trust level bypasses redaction. Publishes `outbound.pii-redacted` to the audit log. (#249)
- **Contact auto-creation rate limiting** — email participant contact creation capped at 10 per message and 100 per hour (configurable). CEO notified when limits are hit; prevents spam-campaign flooding. (#36)
- **CC role detection** — `convertNylasMessage` now computes `curiaRole` (to / cc / bcc) and `primaryRecipientEmails`, giving the coordinator unambiguous context when Curia is CC'd vs. directly addressed.
- **Coordinator memory workflow** — new `## Memory` section in the coordinator prompt with step-by-step guidance on storing facts (`memory-store`) and proactive recall (`memory-query`); covers known contacts, non-contact entities, decay class selection, and disambiguation.
- **`EntityMemory.resolveOrCreate()`** — shared find-or-create primitive now used by both `memory-store` and `extract-facts`, ensuring consistent entity resolution and eliminating code duplication.
- **ADR-017** — CEO-authorized action pattern: `action_risk: "none"` + task-origin check + `humanApproved` flag, reusable for any future CEO-directed skill.
- **ADR-018** — Curia-initiated approval request pattern: gate-blocked skills create `autonomy_action_log` rows and notify the CEO rather than returning a hard error.

### Changed

- **Outbound autonomy gate** — draft-fallback logic moved from the email adapter to `OutboundGateway`; the email adapter is now pure transport. The gateway writes `autonomy_action_log` rows for gated sends, supports two-step draft linkage for the approval-to-send flow, and tracks observation-mode drafts for a unified pending-actions surface. (#435)
- **CEO and system messages bypass autonomy gate** — outbound messages addressed to the CEO (email or Signal) and infrastructure system notifications (e.g. `approval_requested`) now skip the autonomy gate. Gating agent-to-principal messages caused the agent to go mute at low scores and produced phantom `pending_approval` rows when the coordinator tried to confirm approval/denial outcomes. All other safety checks (content filter, PII redaction, blocked-contact) still apply. (#454)
- **`email-draft-save` action risk** — downgraded from `medium` to `low` (min score 60). Drafts are internal mailbox writes the CEO still controls; they do not constitute autonomous outbound communication.
- **`memory-store`** — entity names that don't exist in the KG are now auto-created (via `resolveOrCreate`) rather than returning a rejection; `entity_type` optional input added to hint the node type on creation.
- **Held-message notifications** — enriched with a 500-character plaintext preview of the sender's request, total message length, and a dynamic channel label. (#400)
- **Trust levels** — added `'ceo'` trust level above `'high'`; `meetsMinimumTrust()` helper for ordinal comparison. CEO bootstrap sets `trust_level = 'ceo'` on the CEO contact. (#249)
- **PII scrubber** — replaced deprecated `@openredaction/openredaction` with `openredaction` v1.1.2; reordered CREDIT_CARD before PHONE patterns to prevent partial matches; added PHONE_US parenthesized-format fix. (#252)
- **`action_risk` enforcement** — `SkillRegistry.register()` now throws at startup if a skill manifest omits `action_risk` (previously silently accepted).
- **Coordinator** — strengthened contact-lookup-first rule; added CC'd email handling guidance; trust-channel narration now only raised when declining a specific request.
- **DreamEngine** — accepts an optional `AutonomyScoringPass` as a sibling pass, running on its own interval alongside memory decay.

### Fixed

- **Approval lifecycle** — multiple correctness bugs addressed after testing: gateway-blocked sends now notify the CEO immediately (`notification_sent_at` was always NULL before); `pending_approval` rows are correctly cleared on approval and denial; `short_ref` is now a globally unique 8-char hex identifier (old per-task sequential scheme caused collisions and made `approve-action` return ambiguous errors); JSONB key casing mismatch in the `send-draft` handler fixed; phantom `actionRef` on insert failure fixed; `approve-action` re-execution for gated email sends now uses a generic `reExecRecipe` pattern.
- **`send-draft` account selection** — the skill now auto-discovers the draft's owning email account when `account` is omitted, searching all configured accounts. Sends use the discovered account's credentials. Missing drafts surface a clear error instead of silently creating a new draft. (#455)
- **CC reply routing** — the dispatcher now includes Message ID and Account in the `[OWNER CC]` preamble; the coordinator uses `email-reply` with these identifiers rather than falling back to `email-draft-save` in the wrong account.
- **Observation-mode draft reply address** — dispatcher includes `From: <sender>` in the observation-mode preamble, preventing the email-triage agent from inferring a stale reply-to address for the same contact.
- **Silent memory store failure** — `memory-store` now returns distinct codes `entity_not_found` and `rate_limited` instead of the generic `rejected`, so the coordinator can respond appropriately to each.
- **`held-messages-process` identify** — no longer crashes with `23505` when the sender's channel identity already exists; resolves the owning contact, cleans up the orphaned new contact, and marks the message processed. (#406)
- **`held-messages-process` trust level** — confirmed contacts now receive `trust_level = 'high'` so subsequent messages from identified senders are not re-held. (#407)
- **Silent email drafts** — observation-mode triage drafts are now created silently; the per-draft CEO email notification has been removed. Discovery shifts to the daily Signal digest. (#403)
- **Delegate @-prefix normalization** — agent names passed with a leading `@` are stripped before registry lookup, preventing silent delegation failures.

### Removed

- **`autonomy_gated` outbound policy** — superseded by the gateway-level autonomy gate on the `direct` policy. Deployments using `autonomy_gated` must switch to `direct`.
- **CLI held-message notification** — removed vestigial terminal printout; the coordinator's proactive mention is the real notification path.

---

*stopped at the threshold —*
*the system asks before it acts.*
*trust earned, one by one.*

---

## [0.24.0] — 2026-04-29 — "Delegated Authority"

### Added

- **Email-triage specialist** (`agents/email-triage.yaml`): new specialist that owns
  observation-mode inbox triage end-to-end. Classifies inbound email into five categories
  (URGENT, ACTIONABLE, NEEDS DRAFT, LEAVE FOR CEO, NOISE), executes email-domain actions
  directly, and routes out-of-domain items via bullpen. Capability-aware: consults the
  available-specialists list rather than hardcoding action types.
- **`inject_specialists` agent YAML field** *(public API surface)*: opt-in for any
  specialist that needs the `${available_specialists}` runtime injection, previously
  coordinator-only.
- **`expected_duration_seconds` agent YAML field** *(public API surface)*: agents declare
  their expected runtime; the coordinator injects a matching `timeout_ms` into delegate
  calls, replacing the fixed 90s default for long-running specialists.
- **Proactive signal sends from scheduled jobs** — `signal-send` pinned in the
  coordinator's tool list so it is always available during scheduler runs. Closes #374,
  unblocks spec 17.
- **Missing coordinator skills pinned** — `contact-rename`, `contact-set-trust`,
  `memory-query`, `memory-store`, `image-generate`, and `skill-registry` added to
  `pinned_skills`. These capabilities existed but were invisible to the coordinator.

### Fixed

- **CEO entity context enrichment** — `bootstrapCeoContact()` now creates a KG person node
  and links it on the CEO contact. Previously `kg_node_id` was `NULL`, making entity
  enrichment, standing instructions, and relationship queries non-functional for the CEO.
  Existing contacts are backfilled automatically on next startup. Closes #380.
- **Specialist delegation reliability** — three compounding failures that caused
  long-running specialists (essay-editor and others) to fail reliably (#387):
  - Agents now receive their Google Workspace account list in the system prompt,
    eliminating LLM-guessed email addresses for MCP tools.
  - `expected_duration_seconds` in agent YAML controls delegate timeout (see Added above).
  - The coordinator sends a brief acknowledgment before delegating long-running tasks on
    synchronous channels so the user isn't left watching a dead screen.
- **`executive-profile-update`** — `sign_off` no longer silently dropped when the LLM
  emits camelCase (`signOff`). Added `normalizeKeysToSnakeCase()` utility for skill
  handlers.

### Changed

- **Coordinator observation-mode protocol** — ~45 lines of triage logic replaced with a
  ~15-line delegation rule; the email-triage specialist owns the full protocol now.
- **Channel account injection** — `channelAccounts` and Google Workspace accounts injected
  into all agents' system prompts, not just the coordinator's.

---

*the inbox hands off —*
*each specialist knows its weight;*
*authority flows*

---

## [0.23.0] — 2026-04-28 — "Own Voice"

### Added

- **Executive profile** — CEO writing voice (tone, formality, patterns, vocabulary, sign-off) defined in `config/executive-profile.yaml` and managed by `ExecutiveProfileService`. Injected into the coordinator system prompt on every turn with hot-reload support. DB-versioned with audit trail, HTTP API at `/api/executive` (spec 13).
- **Executive profile skills** — `executive-profile-get` and `executive-profile-update` for conversational profile setup and iterative refinement without editing YAML.
- **`outbound.notification` event type** — system notifications now route through the bus and outbound content filter pipeline instead of bypassing it. Closes #206.
- **Draft-gate CEO notification** — when a Nylas draft is created, CEO receives an email notification to review and send from their client (#278).

### Changed

- **Coordinator email account selection** — eliminated conflicting prompt rules that caused drafts to land in the agent's outbox instead of the CEO's. Account selection now follows explicit ordered rules with contact-lookup reinforcement.

### Fixed

- **Calendar timezone display** — all three calendar skills now return timestamps in the user's local timezone instead of UTC. Added `toLocalIso()` and `formatDisplayTimezone()` utilities; exposed `timezone` on `SkillContext` (additive, non-breaking API change). Fixes #362.
- **`held-messages-process` block idempotency** — `block` action handles duplicate-key errors on retry the same way `identify` does, preventing held messages from getting stuck in `pending` (#335).
- **email-draft-save observability** — handler logs a warning when a non-observation-mode draft omits the `account` parameter, flagging likely misrouted drafts.

---

*Tone set in the seed —*  
*the clock now learns where you stand,*  
*drafts wait for your hand.*

---

## [0.22.0] — 2026-04-26 — "Knowledge Surface"

### Added

- **`memory-store` skill** — agents can now write facts directly to the knowledge graph: store named attribute facts about any entity with explicit control over confidence, decay class, and sensitivity. Returns one of four outcomes (`created`, `updated`, `conflict`, `rejected`), surfacing contradictions to the CEO before writing (spec §03, #297).
- **`memory-query` skill** — freeform semantic search over the knowledge graph via pgvector cosine similarity; supports `type`, `max_sensitivity`, and `limit` filters (spec §03, #298).
- **`config-store` skill** — generic namespaced key-value store backed by the knowledge graph. Agents declare a namespace in their system prompt and call `store`/`retrieve`/`list_namespaces` without a bespoke per-domain skill. Supersedes the `knowledge-*` pattern for new agents.
- **`image-generate` skill** — generates images via DALL-E 3; returns a CDN URL. General-purpose prerequisite for the upcoming essay-editor agent.
- **KG explorer: sensitivity visualization** — node detail drawer, color-by toggle (type / sensitivity / decay class), degree-based node sizing, and confidence-based opacity (#350). `/api/kg/nodes` and `/api/kg/graph` now return `sensitivity` and `properties` on every node.
- **Observation triage event** (`observation.triage.completed`) — structured bus event emitted after every observation-mode triage task, carrying classification, skills called, and action count (#311). `AgentResponsePayload.skillsCalled` added to the public API (additive, non-breaking).

### Changed

- **Observation-mode hardening** — `email-reply` is hard-blocked in observation mode at the skill layer; `email-draft-save` requires `triage_classification: "NEEDS DRAFT"`. Task metadata is now threaded end-to-end from the `agent.task` event into `SkillContext`, making task-level signals available to any handler (closes #305).
- **Release process** — CLAUDE.md now documents the full release workflow: version bump timing, CHANGELOG condensing, PR format, tag and publish steps.

### Fixed

- **Smoke test timeouts** — per-turn timeout raised from 60s to 120s (configurable via `SMOKE_TIMEOUT_MS`); a warm-up message absorbs cold-start latency; error output now includes per-turn timings.

---

*Facts inscribed in graph —*  
*agent writes, the record keeps,*  
*intent stays its course.*

---

## [0.20.0] — 2026-04-24

### Security

- **Per-capability skill registry** — replaces the all-or-nothing `infrastructure: true` manifest flag with per-capability `"capabilities": [...]` declarations. Skills now declare only the privileged services they actually need (e.g. `["outboundGateway"]`), eliminating the blast-radius risk where any infrastructure skill got bus, agent registry, calendar, memory, and scheduler access all at once. The loader validates names against a fixed allowlist at startup, rejects unknown capability names hard (crash, not silent skip), and freezes manifests after loading so handlers cannot self-escalate at runtime. Closes #119.

### Changed

- **`skill.json` schema** — `infrastructure: boolean` removed; `capabilities: string[]` added. **Breaking change to public API surface.** Skills that previously declared `infrastructure: true` now declare the specific capabilities they need (or nothing, if they only used universal services). See `docs/dev/adding-a-skill.md` for the full capabilities reference.
- **`SkillManifest` type** — `infrastructure?: boolean` replaced by `capabilities?: string[]` in `src/skills/types.ts`.
- **ExecutionLayer** — `if (manifest.infrastructure)` block and three name-gated conditionals replaced by a single capabilities loop with fail-closed behavior.

### Fixed

- **`query-relationships` skill** — `last_confirmed_at` in relationship output now serializes as an ISO 8601 string instead of a raw `Date` object, consistent with all other skills that surface timestamps (#359)

---

## [0.19.7] — 2026-04-24 — "The Reading Room"

### Added

- **CEO inbox read skills** (`email-list`, `email-get`, `email-draft-save`) and a fifth triage category `LEAVE FOR CEO` for personal/sensitive email the CEO handles themselves
- **`contact-rename` skill** — update a contact's display name

### Changed

- **KG Explorer** — click-to-explore: auto-loads 20 recent nodes, tap to expand neighbors in-place, node/edge size proportional to confidence, fcose layout. Adds `cytoscape-fcose`.
- **Prompt caching** — system prompt and last tool definition marked cacheable; 60–80% input token reduction on repeat calls within the 5-minute TTL
- **Observation mode** — triage protocol moved to system prompt (cacheable); coordinator response is now audit-only (outbound actions via explicit skill calls); default model bumped to `claude-sonnet-4-6`

### Fixed

- **Scheduler job completion** — tracking entry was set after async publish, so every run was reaped as timed-out; all cron jobs were accumulating failures and auto-suspending
- **Outbound trust propagation** — replies to Curia-initiated emails no longer held; successful sends promote recipient to `confirmed`; forwarding attack closed (issue #330)
- **Calendar ownership and disambiguation** — `calendar-register` now requires explicit `contact_id`; coordinator defaults to CEO's calendar when scheduling on their behalf
- **Research analyst and held messages** — research-analyst caps `web-fetch` to 3–4 targeted fetches; duplicate identity links no longer stall held messages in `pending`

---

## [0.18.1] — 2026-04-12

### Fixed

- **Observation-mode NOISE drafts (partial)** — added explicit "Do NOT call email-reply" language to the triage preamble for NOISE classifications. Superseded by the proper dispatch-layer fix in 0.18.2 (the drafts were never coming from `email-reply` — they came from the auto-reply path in `handleAgentResponse`).

---

## [0.18.0] — 2026-04-11

### Added

- **Dream Engine** (spec 17) — background KG maintenance job that decays confidence on `slow_decay` / `fast_decay` nodes and edges using configurable half-lives (180 d / 21 d), soft-deletes rows at/below the archive threshold via `archived_at`, and cascades archival through edges. All KG read paths filter archived rows. Wired as an internal Scheduler job, configured under `dreaming.decay.*`. Closes #27.
- **Dynamic skill discovery** (spec §03) — agents with `allow_discovery: true` receive the built-in `skill-registry` tool, which keyword-searches all registered skills (local + MCP). After a successful search, `AgentRuntime` expands the per-task working tool list with the full schemas of the returned skills via `ExecutionLayer.getToolDefinitions()`, making discovered skills directly callable with no proxy indirection or schema loss. Expansion is per-task, accumulates across calls, and still routes every invocation through the elevation gate. Google Workspace MCP tools were removed from `pinned_skills` and are now discovered on demand. Closes #274, #291.
- **Multi-account email channel** (spec §03) — `channel_accounts.email` supports N named Nylas-backed accounts, each with its own grant ID, `self_email`, and `outbound_policy` (`direct | draft_gate | autonomy_gated`). One `EmailAdapter` is constructed per account; inbound events are stamped with the receiving `accountId` and replies route back through the same account. `draft_gate` saves the coordinator's reply as a Nylas draft; `autonomy_gated` checks the global autonomy score and falls back to `draft_gate` when below `autonomy_threshold`. `createEmailDraft` added to `OutboundGateway`. If `channel_accounts.email` is absent, the legacy single-account `NYLAS_GRANT_ID` / `NYLAS_SELF_EMAIL` env-var path still works. Closes #272.
- **CEO inbox observation mode + inbox triage** — `observation_mode: true` on a `channel_accounts.email` entry makes the adapter passive: no contact auto-creation, trust-score floor bypassed, and the coordinator receives the email with `observationMode: true` in metadata. `excluded_sender_emails` (supports `env:VAR_NAME`) suppresses self-reply loops. On top of that, the dispatcher injects a 4-way triage preamble (URGENT / ACTIONABLE / NEEDS DRAFT / NOISE) into every observation-mode task with the Nylas message ID so the coordinator can act directly. New `email-archive` skill removes the INBOX label via Nylas (reversible); `OutboundGateway.archiveEmailMessage` added. Closes #273 (inbound), #296.
- **Google Workspace MCP integration** — wired `taylorwilsdon/google_workspace_mcp` as a stdio MCP server providing Gmail / Calendar / Drive tools. Tools are registered alongside local skills and reached via dynamic skill discovery rather than being pinned to the coordinator. Runbook in `docs/dev/google-drive.md`.
- **MCP HTTP transport + `headers` config** — SSE server entries in `config/skills.yaml` now use `StreamableHTTPClientTransport` (the recommended SDK transport) instead of the deprecated `SSEClientTransport`, and accept an optional `headers: Record<string, string>` field for `Authorization: Bearer <token>` against hosted MCP servers. Resolves the ADR 016 migration note. Closes #271.
- **`config/local.yaml` override** — optional deployment-specific YAML file deep-merged on top of `default.yaml` at startup; gitignored here, supplied by deployment repos (e.g. `curia-deploy`). Primary use case: injecting `channel_accounts.email` without touching the upstream config.
- **`accountId` on bus events** — optional `accountId` added to `InboundMessagePayload`, `AgentTaskPayload`, and `OutboundMessagePayload` so replies always leave from the account that received the original message. Additive; existing handlers are unaffected.

### Fixed

- **Skill manifest parser crash at startup** — `email-archive`, `bullpen`, and `contact-set-trust` shipped `skill.json` `inputs` blocks using the em-dash/colon shorthand, which the registry's primitive-type allowlist now rejects at boot — taking the container down with a fatal healthcheck failure on `0.17.10`. Rewritten all three manifests to the canonical `"type (description)"` form, and added a regression guard in `tests/unit/skills/loader.test.ts` that runs `toToolDefinitions()` against every installed manifest so future typos fail CI instead of prod.
- **Coordinator defaults to its own account for third-party tool calls** — system prompt hardened so the coordinator no longer populates `user_google_email` (or similar) with the CEO's address, which was forcing workspace-mcp into fresh OAuth flows for accounts it had no credentials for.
- **Migration prefix conflicts** — resolved duplicate `014_*` / `015_*` prefixes that broke `node-pg-migrate` startup ordering. `014_add_kg_node_sensitivity.sql` was renumbered to `024_`. A prior rename of `020_add_contact_trust_fields.sql` to `019_` was reverted because prod's `pgmigrations` table records it as `020_`, so the mismatch was causing a `checkOrder` startup failure. Closes #284, #286.

---

## [0.17.0] — 2026-04-10

### Breaking Changes

- **Agent YAML schema now enforced at startup** — previously ignored unknown keys and missing required fields now cause a descriptive `process.exit(1)`. Any `agents/*.yaml` that was silently tolerated must be fixed before upgrading.
- **Skill manifest schema now enforced at startup** — same as above for `skills/*/skill.json`. Invalid manifests (missing `version`, `action_risk`, unknown keys) cause startup failure.
- **`MessageRejectedPayload.reason`** extended with `'message_too_large'`, `'global_rate_limited'`, and `'sender_rate_limited'` (bus event type, public API surface) — exhaustive handlers over the `reason` union must add these cases. The payload also gains optional `size` and `limit` fields populated when the reason is `message_too_large`.
- **HTTP 413 for oversized messages** — inbound messages that exceed `channels.max_message_bytes` now receive HTTP 413 (Payload Too Large) instead of 403.

### Security

- **Input validation** — startup validator (`src/startup/validator.ts`) validates `config/default.yaml`, all `agents/*.yaml`, and all `skills/*/skill.json` against JSON Schema (Ajv) at boot time. Invalid configs cause a descriptive `process.exit(1)` before any service initializes (spec §06).
- **Message size limiting** — dispatcher rejects inbound messages exceeding `channels.max_message_bytes` (default 100 KB) before routing; rejection is audit-logged as `message.rejected` with causal `parentEventId` and includes the message byte size and configured limit (spec §06).
- **Rate limiting at the dispatch layer** — two independent in-memory fixed-window rate limits: a global limit (default 100 msg/min) checked before policy-gate processing to stop aggregate DoS floods, and a per-sender limit (default 15 msg/min) checked after policy gates. Violations audit-logged as `message.rejected` with reason `global_rate_limited` or `sender_rate_limited`. Configurable under `dispatch.rate_limit` in `config/default.yaml`. Closes #198.

### Added

- **MCP client layer** — Curia can now connect to any MCP-compatible tool server at startup. Servers are declared in `config/skills.yaml` (stdio or SSE transport). Discovered tools are registered transparently in `SkillRegistry` alongside local skills — agents cannot distinguish local from MCP tools, and all MCP calls flow through the `ExecutionLayer` (sanitization, timeouts, sensitivity gating, audit log). Connection failures warn-not-crash; absence of `config/skills.yaml` is treated as "no MCP servers configured". Closes #270.
- **`config/skills.yaml`** — new operator config file for declaring MCP server connections. `action_risk` is required per server; no default is provided, forcing explicit risk declaration.
- **`schemas/` directory** — JSON Schema files for agent configs, skill manifests, `config/default.yaml`, and `config/skills.yaml`. Schemas are legible without TypeScript and can be validated with third-party tools. Includes `schemas/skills-config.json` validated by the startup validator at boot time.
- **ADR 016** — documents the choice of `@modelcontextprotocol/sdk` over a hand-rolled transport, the registry-transparent design, and the `SSEClientTransport` deprecation risk.
- **Data sensitivity tags on KG nodes** — every KG node now carries a `sensitivity` field (`public | internal | confidential | restricted`). `EntityMemory.createEntity()` and `storeFact()` auto-classify content via `SensitivityClassifier` using keyword rules from `config/default.yaml` (`sensitivity_rules`). Explicit caller overrides always win. Sensitivity is threaded through `memory.store` audit events, enabling downstream gating (e.g. bulk export). Closes #200.
- **Intent drift detection** — after each burst of a persistent scheduled task, an LLM judge compares the current `task_payload` against the original `intent_anchor`. Drifting tasks are paused and a follow-up `agent.task` is dispatched to the coordinator to notify the CEO (spec §06). Configured via `intentDrift:` block in `config/default.yaml`.
- **`channels.max_message_bytes`** in `config/default.yaml` — configures the inbound message size limit (default `102400`).
- **Real-config validator tests** — `tests/unit/startup/validator.test.ts` now validates the actual `config/default.yaml`, `agents/*.yaml`, and `skills/*/skill.json` against their schemas. Catches schema/config drift in CI before it reaches prod.

### Changed

- **Spec 03 implementation status** — MCP skills row updated to Done; remaining rows corrected and annotated: secrets access marked Done, safety gate and skill discovery marked Partial, skill-registry cross-referenced to #274.
- **Agent and skill loaders** — manual field checks removed; validation is now handled entirely by the startup validator schema.

### Fixed

- **`dispatch.rate_limit` missing from `default-config.schema.json`** — the rate-limit config block was not declared in the schema, causing startup validation to reject the config with `additionalProperties` on every deploy. Schema now allows `window_ms`, `max_per_sender`, and `max_global` under `dispatch.rate_limit`.
- **Delegate skill timeout now wired to `expected_duration_seconds`** — the delegate skill previously used a hardcoded 90-second timeout, causing long-running scheduled specialists to time out unnecessarily. `expected_duration_seconds` from the scheduler job is now forwarded through the `agent.task` event payload and injected as `timeout_ms` on every `delegate` call. The 90-second default is preserved for interactive tasks. The delegate skill outer execution timeout has been raised to 660 s to accommodate jobs up to 600 s. Closes #258.
- **`CreateJobParams` now accepts `expectedDurationSeconds`** — dynamic job creation (HTTP API, skills) previously could not set `expected_duration_seconds`; the field was only reachable via declarative YAML. `CreateJobParams` now exposes the field with the same validation rules as the YAML path. Part of #258.
- **Null byte crash in audit logger** — `AuditLogger.log()` now strips U+0000 from all string values in event payloads before writing to `audit_log.payload`. Previously, binary content from `web-fetch` could embed null bytes that PostgreSQL rejects with `22P05`, crashing the agent task mid-run. Fixes josephfung/curia#257.

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

[Unreleased]: https://github.com/josephfung/curia/compare/v0.30.0...HEAD
[0.30.0]: https://github.com/josephfung/curia/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/josephfung/curia/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/josephfung/curia/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/josephfung/curia/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/josephfung/curia/compare/v0.25.1...v0.26.0
[0.25.1]: https://github.com/josephfung/curia/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/josephfung/curia/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/josephfung/curia/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/josephfung/curia/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/josephfung/curia/compare/v0.20.0...v0.22.0
[0.20.0]: https://github.com/josephfung/curia/compare/v0.19.7...v0.20.0
[0.19.7]: https://github.com/josephfung/curia/compare/v0.18.1...v0.19.7
[0.18.1]: https://github.com/josephfung/curia/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/josephfung/curia/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/josephfung/curia/compare/v0.16.0...v0.17.0
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
