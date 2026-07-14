# Diagnostics agent — design (#1356)

**Status:** in progress · **Date:** 2026-07-14 · **Issue:** #1356 · **Size:** XL

A read-only, opt-in `diagnostics` specialist that answers fuzzy operational
"what happened / why" questions (an ID, a time window, or a described symptom)
by querying its own audit + operational state, following the causal chain, and
returning an ordered narrative + grounded root-cause hypothesis + a recommended
mitigation. This is the SSH-and-hand-query-`audit_log` workflow moved into a
conversation with Curia.

## Shape

One new agent + three read-only skills + one new read repo + one migration.

```
agents/diagnostics.yaml            powerful tier, role: specialist, opt-in
skills/audit-query/                audit_log read by id/block/conversation/task/window
skills/audit-trace/                walk parent_event_id up + children down → causal chain
skills/ops-lookup/                 operational + agent-state tables via `source` param
src/diagnostics/diagnostics-repo.ts   read-only repo for the ops/agent-state tables
src/diagnostics/redact.ts          shared PII/summary redaction for diagnostic output
src/audit/audit-log-repo.ts        + findById / findChildren / findByBlockId
src/db/migrations/072_*            index on payload->>'blockId'
```

## Key facts established during exploration

- **Model tier** — `powerful` is already mapped to `claude-opus-4-6`
  (`config/default.yaml`). No config change; diagnostics is the first `powerful`
  agent, which validates the tier→model mapping (ADR-014) in prod.
- **Opt-in / disabled by default** — reconciliation only auto-enables agents/skills
  *listed* in `config/registry-defaults.yaml`. Omitting the agent + its skills leaves
  them discovered-but-disabled (same pattern as `ceo-inbox`/`calendar`). An operator
  enables them manually. While disabled the agent is absent from `AgentRegistry`, so it
  is invisible to the coordinator roster and `delegate` rejects it.
- **Never externally inbound-reachable** — the dispatcher hardcodes external inbound to
  `coordinator`; specialists are reachable only via `delegate` (`allowed_callers:
  ["coordinator"]`). `role: specialist` gives this for free — no new field needed.
- **Capabilities** — a skill reaches a repo only if its `skill.json` declares a
  capability on the fixed allowlist, wired in ~7 places. Adding **one** new capability
  (`diagnosticsRepo`) keeps the read surface in a single auditable file.
- **Redaction** — migration 070 is a documentation-only no-op (its `UPDATE` would trip
  the append-only trigger). Real redaction utilities: `scrubPii()` (`src/pii/scrubber.ts`)
  for free text, and the execution layer already runs `sanitizeObjectOutput()` on every
  skill result (structured secrets: API keys/JWT/AWS/long-hex). `scrubPii` does **not**
  run automatically, so we apply it ourselves to the content fields we surface.

## Routing & clarifying questions — reuse generic mechanisms (no coordinator edits)

Two design constraints — "the coordinator recognizes and delegates the handoff" and
"the agent can ask the principal clarifying questions" — are both met **without any
diagnostics-specific coordinator code**, so adding future agents never means editing the
coordinator (no whack-a-mole):

- **Routing** is driven entirely by the agent's `description`. The runtime injects every
  enabled specialist into the coordinator's `## Available Specialists` block
  (`agentRegistry.specialistSummary()` → `- @name: description`), and the coordinator's
  existing generic "delegate to the right specialist" logic routes on it. The routing
  trigger *and* the principal-only signal live in the diagnostics `description`; the
  coordinator system prompt is **unchanged**.
- **Clarifying questions** reuse the existing `request-clarification` skill + the
  coordinator's generic clarification-resume flow. Diagnostics calls
  `request-clarification`; the task pauses, the coordinator routes the question to the
  principal, and diagnostics is resumed automatically with the answer **and its full prior
  context** (multiple rounds supported). Nothing about that flow is agent-specific.

## Principal-restriction — how it is actually enforced

There is no agent-level `principal_only` flag, and none is needed. Enforcement is layered:

1. **Structural (primary).** Diagnostics holds read-only query skills plus
   `request-clarification` only — no `email-*`, `signal-send`, `send-draft`, `delegate`,
   or memory-write skills. It has **no skill that can address an arbitrary recipient**; its
   one reach-out, `request-clarification`, is principal-*directed* by construction (it
   pauses and routes a question to the principal via the coordinator). So it physically
   cannot leak internal state to a non-principal. Findings return to the coordinator as the
   `delegate` result.
2. **Action gate (Gate C).** If the coordinator invokes an outbound skill carrying
   diagnostic content to a third party, Gate C consults the (wired) escalation judge
   (`classifyAction` → `applyActionPolicy`) and escalates third-party-facing disclosure,
   failing closed. (`#949` is merged; the disclosure gate is live at Gate C. The
   `escalationJudge`-into-`OutboundContentFilter` Stage-2.5 hook is dormant/redundant and
   the "wiring still pending" comment in `index.ts` is stale — out of scope here.)
3. **Audience-leak judge (Stage 2).** Its rule (b) already flags "internal system state,
   tools, agents, skills, errors, backend status" reaching a non-principal — which is
   exactly what diagnostic output is. No prompt change required.
4. **Prompt guardrails.** The diagnostics `description` and system prompt declare its
   output is internal, principal-only, and it refuses non-principal audiences.

Verification for the acceptance criterion is a unit test asserting the agent's
`pinned_skills` contains no outbound/delegate/write skill (request-clarification, being
principal-directed, is the sole allowed communication path).

## Skill designs (all `action_risk: "none"`, parameterized, read-only)

### audit-query
Inputs: `event_id?`, `block_id?`, `conversation_id?`, `task_id?`, `event_types?`,
`since?`, `until?`, `limit?`. Resolves the narrowest scope available:
- `event_id` → `AuditLogRepo.findById`
- `block_id` → `AuditLogRepo.findByBlockId` (payload->>'blockId', indexed by migration 072)
- otherwise → `findByEventTypes` (when `event_types` given) or `findTimeline` (window /
  conversation / task). Returns bounded, redacted event records (structural fields +
  `payloadSummary`), plus `hasMore`.

### audit-trace
Inputs: `event_id?` **or** `block_id?`, `max_depth?` (default 20), `max_children?`.
Resolves the anchor, walks `parent_event_id` **up** to the root (bounded), then walks
`findChildren` **down** breadth-first (bounded), assembling a de-duplicated, timestamp-
ordered causal chain of redacted event records. Reports when a bound truncated the walk.

### ops-lookup
Input: `source` (one of `scheduled_jobs | messages | action_log | outbound_context |
working_memory`) + scope filters (`conversation_id?`, `task_id?`, `agent_id?`, `id?`,
`since?`, `until?`, `status?`, `limit?`). Each source hits one read method on
`DiagnosticsRepo`. Notes:
- `outbound_context` returns rows **including** released/expired-but-not-yet-swept, since
  the diagnostic signal (empty `delegation_hint`, `released` state) is in exactly those
  rows. When a source returns zero rows for the scope, the result carries
  `available: false` so the agent reports "unavailable / expired," never confabulates.
- `working_memory.content` is the most sensitive field: `scrubPii()` + truncation to a
  bounded preview; never the full raw scratch.
- `messages` reads `held_messages` (inbound held for review). Drafts are surfaced via the
  `action_log` source (draft state lives in `autonomy_action_log.payload`).

### Deferred (documented, per issue open questions)
- `working_documents` (OKF workspace) — deferred.
- Symptom classification is left to the agent's reasoning; skills stay ID/scope-anchored.

## DiagnosticsRepo + redaction

`DiagnosticsRepo(pool, logger)` — parameterized SELECTs only, mirroring `AuditLogRepo`.
One method per source, each returning typed rows scoped by the diagnostic filters.
`src/diagnostics/redact.ts` provides `redactText()` (scrubPii + truncate) and
`summarizePayload()` (bounded, scrubbed object summary) shared by all three handlers. The
execution layer's `sanitizeObjectOutput` remains the outer net for structured secrets.

## Migration 072

`idx_audit_log_payload_block_id` on `((payload->>'blockId')) WHERE payload->>'blockId'
IS NOT NULL`, mirroring the migration-071 `taskId` index. Makes "what happened with
`block_…`?" (the headline case) an index lookup rather than a scan. Includes a down.

## Tests

- `audit-trace`: seeded `audit_log` chain (root → child → grandchild via
  `parent_event_id`) reconstructs in timestamp order; bound truncation reported.
- `audit-query`: `findById` / `findByBlockId` routing; payload redaction applied.
- `ops-lookup`: `scheduled_jobs` + `audit_log` cross-table correlation data (two
  overlapping jobs surfaced alongside their audit events); `working_memory.content`
  redacted; empty scope → `available: false`.
- `diagnostics.yaml`: pinned skills contain no outbound/delegate/write skill.

## Registry & changelog

- `config/registry-defaults.yaml` — add NOTE comments documenting the agent + skills as
  opt-in/excluded; do **not** list them.
- CHANGELOG **Added** entries for the agent and the skills.
- Versions: agent `0.1.0`; each skill `0.1.0`. Coordinator is **unchanged** (routing +
  clarification reuse its existing generic flows).

## Scoping decisions

- **Setup-wizard catalog: not added.** The catalog (`skills/setup-status/catalog.yaml`) is
  "what a new user sets up on a fresh install." Diagnostics is deliberately opt-in,
  credential-free, and excluded from onboarding — an advanced operator enables it by hand.
  A catalog entry (with `completion_check` / `credential_how_to` / `docs_url`) would imply
  it belongs in the default setup flow, which it does not. A curia-docs page + catalog entry
  would be a reasonable follow-up if it graduates from opt-in.
- **Stale comment left in place (flagged, not fixed).** `src/index.ts` still says
  "`#949 disclosure-gate wiring is still pending`" though #949 shipped the tier disclosure
  gate at Gate C. Out of scope for this issue; worth a one-line cleanup separately.

## Verification performed

- Full unit suite green (388 files, 4980 tests); typecheck + lint clean.
- Boot-path load check: the three skills discover with valid capabilities / `action_risk:
  none` / `allowed_callers: [diagnostics]`, and the agent parses at `powerful` tier pinning
  only the four read-only skills.
- Repo SQL covered by the Postgres integration suite (`findById` / `findChildren` /
  `findByBlockId`), which self-skips without `DATABASE_URL`.
