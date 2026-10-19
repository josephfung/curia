# 13 — Office Identity

**Date:** 2026-04-04 (revised 2026-05)
**Status:** Draft

> **Revision (May 2026, #771):** The original design loaded identity from
> `config/office-identity.yaml` with a chokidar file watcher. Both have been
> removed. The sections below have been updated to describe the current
> DB-first flow; the source of truth is now `src/identity/defaults.ts` for
> the seed and the `office_identity_*` tables for everything after.

## Overview

Curia represents a single "Office of the CEO." All external communication flows through one unified persona — the Coordinator. The goal of this spec is to define how that persona is configured, stored, and enforced.

The key principle:

> **Character is a property of the office, not of each agent.**

The office has one voice, and every agent that writes outward uses it (#2143). The
coordinator gets the identity block as who it is; every other agent gets the same contract
in writes-as mode (see [Specialists](#specialists)), because its own YAML already says what
it is. Until #2143, specialist agents had no identity block at all, and messages they wrote
to the principal or to third parties carried no tone, length or standing preferences.

---

## Design Principles

1. **One source of truth** — identity lives in a single config, not scattered across agent files
2. **Instance-level config** — office identity is about the deployment, not the coordinator agent specifically; it belongs alongside other instance config, not inside an agent definition
3. **Mutable at runtime** — identity can be changed via the onboarding wizard without a restart; changes take effect on the next coordinator turn
4. **Auditable** — every identity change is versioned and logged; drift is visible
5. **Constraints are hard** — the `constraints` block overrides everything else; no overlay or update may bypass it

---

## What Belongs Here vs. Elsewhere

| Concern | Lives in |
|---------|----------|
| Assistant name, title, tone | `src/identity/defaults.ts` (seed) + `office_identity_*` DB tables (authoritative) — this spec |
| Executive writing voice (how the CEO writes) | `ExecutiveProfile.WritingVoice` (`src/executive/types.ts`) — see [Writing-voice learning](#writing-voice-learning) below |
| Coordinator routing, delegation, skills | `agents/coordinator.yaml` |
| Channel trust, permissions | `config/channel-trust.yaml`, `config/permissions.yaml` |
| Per-agent task behavior | agent's own `system_prompt` |
| Channel-specific tone adjustments | Future extension (see below) |

---

## Config Schema

The seed values live in `src/identity/defaults.ts` as a TypeScript constant
(`DEFAULT_OFFICE_IDENTITY: OfficeIdentity`). On first boot they are written to
the `office_identity_versions` table with `changed_by='system_default'`. All
subsequent edits go through the wizard or `PUT /api/identity` and supersede
the seed. To change the defaults, edit `defaults.ts` and ship a new release;
running deployments are unaffected (they already have a DB row).

The runtime shape is defined by the `OfficeIdentity` interface in
`src/identity/types.ts` — see [OfficeIdentityService](#officeidentityservice)
below.

### Field reference

| Field | Type | Purpose |
|-------|------|---------|
| `assistant.name` | string | External-facing name used in all outbound communication |
| `assistant.title` | string | Role title used in email signatures and introductions |
| `assistant.email_signature` | multiline string | Full email sign-off block. The outbound gateway adds it below every email it sends or drafts, except system notifications and mail from the principal's own mailbox; empty means name and title (prompt trim PR 6). A sign-off the model wrote at the end of the body (lines naming only the assistant's name, title or signature lines) is dropped first, so the signature appears once (#2138) |
| `tone.style` | string (1–800 chars) | How the assistant sounds, in the operator's words, usually started from a console template that ends in an example line (`Sounds like: "…"`). Rendered verbatim (#2143) |
| `tone.verbosity` | integer 0–100 | The Detail slider. 0 = tersest, 100 = most thorough; `compileSystemPromptBlock()` translates it to length guidance |
| `behavioral_preferences` | string[] | Ordered list of standing preferences compiled into the system prompt |
| `constraints` | string[] | Hard rules placed before all other identity content; cannot be overridden |

**Removed in #2143:** `tone.baseline` (1–3 tone words), `tone.directness` and
`decision_style`. Tone words gave the model nothing to imitate; directness became the
written style plus a fixed honesty line; decision style duplicated the autonomy level
(spec 14), which owns act-vs-ask. `PUT /api/identity` rejects all three by name.

---

## Database Schema

The DB is the authoritative source for identity. It also keeps a full version
history of every change for audit and drift detection.

```sql
-- Full version history of every identity change.
CREATE TABLE office_identity_versions (
  id          SERIAL PRIMARY KEY,
  version     INTEGER NOT NULL,           -- monotonically increasing
  config      JSONB NOT NULL,             -- full office_identity config at time of change
  changed_by  TEXT NOT NULL,              -- 'system_default' | 'wizard' | 'api' | 'file_load' (legacy)
  note        TEXT,                       -- optional human-readable reason for change
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Single-row table pointing to the active version.
-- The singleton constraint ensures only one row can exist.
CREATE TABLE office_identity_current (
  singleton   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  version_id  INTEGER NOT NULL REFERENCES office_identity_versions(id),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

**Legacy rows.** Rows written before #2143 still hold the removed fields. Every read of a
stored config (load, reload, `history()`, the audit diff) goes through
`normalizeIdentity()` (`src/identity/normalize.ts`): a row with no `tone.style` gets one
built from its tone words and directness ("Candid, warm and direct. State positions
plainly; avoid softening language."), or the default style when it had no words, and the
legacy keys are always dropped. Nothing is written back; the next save persists the new
shape.

**Load precedence at startup:**

1. If `office_identity_current` exists → load from DB.
2. If no DB record → seed `DEFAULT_OFFICE_IDENTITY` from `src/identity/defaults.ts` as
   version 1 with `changed_by='system_default'`, then load.

`'file_load'` is a legacy `changed_by` value preserved for compatibility with
pre-existing rows from the YAML-file era; it is not produced by new boots.
The `isIdentityConfigured` query at `src/channels/http/routes/identity.ts`
treats `'system_default'` and `'file_load'` identically — only `'wizard'` or
`'api'` count as "configured by the operator."

---

## OfficeIdentityService

A new cross-cutting service in the System layer.

```typescript
interface OfficeIdentity {
  assistant: {
    name: string;
    title: string;
    emailSignature: string;
  };
  tone: {
    style: string;       // 1–800 chars, the operator's words; rendered verbatim
    verbosity: number;   // 0–100; 0 = tersest, 100 = most thorough
  };
  behavioralPreferences: string[];
  constraints: string[];
}

interface OfficeIdentityVersion {
  id: number;
  version: number;
  config: OfficeIdentity;
  changedBy: string;
  note?: string;
  createdAt: Date;
}

interface OfficeIdentityService {
  // Returns the currently active identity (cached in memory after load)
  get(): OfficeIdentity;

  // Saves a new version to the DB, updates the in-memory cache, emits audit event.
  // changedBy: 'system_default' | 'wizard' | 'api' (or legacy 'file_load' on old rows)
  update(config: OfficeIdentity, changedBy: string, note?: string): Promise<void>;

  // Forces a reload from DB (used by hot reload mechanism)
  reload(): Promise<void>;

  // Returns all historical versions, newest first
  history(): Promise<OfficeIdentityVersion[]>;

  // Compiles the identity config into a system prompt block for injection
  compileSystemPromptBlock(): string;
}
```

### compileSystemPromptBlock()

This method produces the block injected into the coordinator's system prompt on each turn. It produces output in this order:

1. Hard constraints (from `constraints[]`) — labeled clearly, placed first
2. Identity header (name, title)
3. **How you sound:** the operator's `tone.style`, then a fixed register line ("Match the
   register of any example lines above, not their content."), which stops the model
   reusing a template's example sentence word for word
4. **Length:** the Detail band's limit per channel (below), an exception for content that
   needs the space, and a fixed content line: "Say what is there, not what isn't, and don't
   explain your own next steps or repeat your instructions." (#2143)
5. A fixed honesty line: "Whatever your tone, say plainly when you are unsure or don't know
   something." Code-owned, so no style text can talk the model out of calibrated
   uncertainty
6. Standing preferences (ordered list)

There is no decision posture: the autonomy level (spec 14) owns act-vs-ask.

Tone data that cannot be rendered (a non-string or empty style, or a verbosity outside
0–100; stored rows are not re-validated on read) is logged at error, and sections 3 and 4
are left out. Everything else still renders: throwing would drop the whole block,
hard constraints included.

`tone.verbosity` (the Detail slider) maps to a limit per channel. One table in
`src/identity/length.ts` serves the block, the per-turn reminder below, and the console's
Detail preview (`GET /api/identity` returns it as `lengthLimits`):

| Band (verbosity) | Signal, SMS and Slack | Email | Voice calls |
|---|---|---|---|
| Brief (0–25) | 1–2 sentences. The answer or outcome only. | Under ~80 words. No warm-up line, no closing summary. | One sentence. |
| Concise (26–50) | 1–3 sentences. | Under ~150 words. | 1–2 sentences. |
| Adaptive (51–75) | Short paragraphs, as the situation needs. | Under ~250 words. | 2–3 sentences. |
| Thorough (76–100) | Thorough; context included. | Thorough; context included. | A few sentences, then offer more. |

Every band ends with "Go longer only when you are asked for detail or the content itself
needs the space (six meetings are six lines).", so brevity never drops required content.

**Per-turn reminder.** The runtime closes a reply turn's guidance with the reply channel's
limit ("This reply goes out on Signal: 1–2 sentences. The answer or outcome only."), the
most salient position available, in the user message so the cached system prefix is not
split. The channel-to-row map is explicit: a channel with no row (console chat, `cli`,
internal and scheduler turns) gets no reminder, never a guessed limit. A scheduled run's
reply goes nowhere, so its delivery guidance carries the content rule instead.

**Markers.** The block's fixed lines (register, honesty, length exception, content line)
and every reminder are prompt-exfiltration marker sources (`TRIGGER_GUIDANCE_MARKER_SOURCES`).
The operator's `tone.style` is not: it holds example lines Curia is meant to imitate.

Example output (default config — the "Warm & personable" template, verbosity `50`):

```
## Identity & Communication Contract

**Hard constraints (non-negotiable):**
- Never impersonate the principal
- Always identify as an AI assistant when asked directly

**Who you are:**
You are Alex Curia, Digital EA.

**How you sound:**
Warm and personable, but brief. Friendly in a few words, never gushing; the point comes first.
Sounds like: "All set: Thursday's call is now at 3. Enjoy the long weekend."
Match the register of any example lines above, not their content.

**Length (Detail: Concise):**
- Signal, SMS and Slack: 1–3 sentences.
- Email: Under ~150 words.
- Voice calls: 1–2 sentences.
Go longer only when you are asked for detail or the content itself needs the space (six meetings are six lines).
Say what is there, not what isn't, and don't explain your own next steps or repeat your instructions.
Whatever your tone, say plainly when you are unsure or don't know something.

**Standing preferences:**
- Be concise unless detail is explicitly requested
- Prioritize signal over noise — surface only what's actionable or strategic
- Escalate ambiguity before taking external action
```

---

## Specialists

Every agent other than the coordinator gets `compileWritesAsBlock()`: the same block, with
section 2 replaced by:

```
**Who you write as:**
Anything you write for the principal or for anyone outside the office goes out from
<name>, <title>, and follows the contract below.
Anything written in the principal's own name (drafts, posts, essays) follows the
principal's voice, not this contract.
Results you return to the coordinator or another agent are not covered; include
everything they need.
```

- **No opt-in flag.** Core and deployment agents can't be told apart at runtime (a
  deployment's image copies its agents into the same directory), and no agent needs to
  opt out yet. The two scoping sentences do the flag's job:
  - **Writing as the principal.** ceo-inbox drafts in the principal's voice from
    `executive-profile-get`; so do a deployment's essay or social-media agents. They keep
    that voice. Scenario 40e guards it.
  - **Reporting to the coordinator.** A result a specialist returns is not shortened by a
    length limit meant for the principal.
- **Standing preferences are included on purpose:** a rule about what a recap contains
  binds whichever agent writes the recap.
- **A separate method, not a parameter,** so a stub that only knows the coordinator block
  fails to compile instead of quietly serving it to specialists.
- **No per-turn length reminder** reaches a specialist: delegated, bullpen and scheduled
  tasks arrive on channels with no length row.
- **The voice runtime** keeps the coordinator block.
- **The prompt budget** counts only YAML prompts and SKILL.md bodies, so the block, about
  400 tokens for the default identity, is not budgeted.

---

## Coordinator Integration

The coordinator system prompt is extended to include an `${office_identity_block}` token, injected at runtime alongside `${agent_contact_id}`, `${available_specialists}`, `${current_date}`, etc.

The existing `persona.display_name`, `persona.tone`, and `persona.title` fields in `coordinator.yaml` are **removed** once this service is in place — they become redundant. The coordinator YAML retains only agent-level config (model, skills, routing).

```yaml
# agents/coordinator.yaml (after migration)
name: coordinator
role: coordinator
description: Central coordinator — routes all messages, delegates to specialists, maintains the unified persona
model:
  provider: anthropic
  model: claude-sonnet-4-6
system_prompt: |
  ${office_identity_block}

  ## Date & Time
  ...
```

---

## Populating `behavioralPreferences`

The `behavioralPreferences` array is populated through three paths:

1. **Form wizard at `/setup`** — step 5 ("Autonomy & preferences") includes a free-form
   textarea. Submitting step 6 calls `PUT /api/identity` with the wizard's
   compiled identity payload, including any new preferences **appended** to
   the existing array. See [spec 18 — Onboarding](18-onboarding.md#layer-2--form-wizard-at-setup).

2. **Console Settings → Standing preferences** (`/settings/posture`, #1376) — post-setup
   editor that replaces the full `behavioralPreferences` list via `PUT /api/identity`
   with `changedBy: 'api'`. The other fields are preserved via read-modify-write so the
   Personality and Standing preferences pages do not clobber each other. The route keeps
   its old name so existing links work; the page held decision-posture cards until #2143.

3. **`behavioral-preferences-update` skill** — invoked by the `setup-wizard`
   specialist agent during the in-chat onboarding conversation (and any
   later "remember that I…" turn the coordinator delegates to it). The
   skill calls `OfficeIdentityService.update(...)` with `'skill'` as the
   `changedBy` value, producing a versioned row per change.

   | Property | Value |
   |----------|-------|
   | `operation` | `'append'` (default, idempotent — deduplicates by exact string match) or `'replace'` |
   | `entries` | non-empty `string[]` |
   | `action_risk` | `low` (internal state write; min autonomy score 60) |
   | `capabilities` | `['officeIdentityService']` |

   The `officeIdentityService` capability is wired into the execution
   layer in `src/skills/types.ts`, `src/skills/loader.ts`,
   `src/skills/execution.ts`, and bootstrapped from `src/index.ts` —
   mirroring the `executiveProfileService` pattern.

   See [spec 18 — Onboarding](18-onboarding.md#layer-3--setup-wizard-specialist-agent)
   for the conversational flow that drives this skill.

---

## Hot Reload

The identity cache in `OfficeIdentityService` is in-memory. Reload is triggered by:

1. **API endpoint** — `POST /api/identity/reload` re-reads from DB. The wizard calls
   this after `PUT /api/identity` saves a new version so the next coordinator turn
   picks up the change.
2. **Startup** — `OfficeIdentityService.initialize()` runs before the coordinator boots
   and populates the cache from DB (or seeds defaults if absent).

The reload is not disruptive — in-flight coordinator turns complete with the previous
identity; the new identity takes effect on the next turn.

---

## Audit Events

Every identity change emits an audit event on the bus:

```typescript
{
  type: 'config.change',
  payload: {
    config_type: 'office_identity',
    version: number,           // new version number
    previous_version: number,  // previous version number
    changed_by: string,        // 'system_default' | 'wizard' | 'api' (or legacy 'file_load')
    note?: string,
    diff_summary: string,      // human-readable summary of what changed
  }
}
```

This event is logged by the audit logger and surfaced in the version history.

---

## HTTP API

New routes under the existing HTTP channel (`src/channels/http/routes/identity.ts`):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/identity` | Returns the current active identity config |
| `PUT` | `/api/identity` | Saves a new version; triggers hot reload |
| `GET` | `/api/identity/history` | Returns all versions, newest first |
| `POST` | `/api/identity/reload` | Forces a reload from DB (used post-wizard) |

All routes accept either a session cookie (set by `POST /auth`) or the
`x-web-bootstrap-secret` header — see `src/channels/http/session-auth.ts`.

---

## Non-Goals

The following are explicitly out of scope for this spec. They are valid future extensions:

- **Channel overlays** — e.g., more formal tone on email, more casual on CLI. Deferred to a later spec. The design intentionally leaves room: the `compileSystemPromptBlock()` method can be extended to accept channel context.
- **Contact overlays** — adapting tone per recipient. Deferred.
- **LLM-suggested identity refinements** — the agent proposes changes, the user approves. Deferred.
- **Multi-instance identities** — one Curia serving multiple offices. Out of scope entirely.

---

## Writing-voice learning

Office identity is how the *assistant* presents itself. Separately, Curia maintains an
**executive writing voice** — how the *CEO* writes — in `ExecutiveProfile.WritingVoice`.
That type carries seeded structured fields (`tone[]`, `formality` 0–100, `patterns[]`,
`vocabulary.{prefer,avoid}`, `signOff`) alongside a learned free-form `guide` (see the
loop below). The profile is read by `executive-profile-get` (e.g. when `ceo-inbox` drafts).
Its structured fields are set via `executive-profile-update`; the learned `guide` is
written only through the `resolve-learning-digest` `approve_voice` action, never by the
weekly job directly. It is versioned in `executive_profile_versions` and emits
`config.change` on every write — the same audit posture as office identity.

### Observation → learn loop (ADR-029)

A weekly `voice-learn` job on `ceo-inbox` (cron `0 8 * * 1`) reads accumulated
`(draft, sent)` diffs from the OKF evidence doc produced by the sent-mail observer
([spec 04](04-channels.md)) and makes a single **batched LLM call**
(`ctx.infraLlm.extract()`) over that accumulated evidence to produce an updated
free-form `WritingVoice.guide`.

The job never writes the profile directly. It records a single pending proposal
object in `config-store` (`voice_learn.proposal`), surfaced in the digest for
CEO review. The CEO approves via the `resolve-learning-digest` skill's
`approve_voice` action, which calls
`executiveProfileService.update({ writingVoice: { ...current, guide } })`.
Dismissed proposals set the `voice_learn.dismissed` config cooldown key before
re-propose.

The learned guide renders into agent prompts through `compileWritingVoiceBlock`,
under a "How the executive actually writes (learned from their edits)" heading.

Raw OKF evidence is swept after it is folded into the profile (retention rule in
[spec 04](04-channels.md)). This loop does **not** use the knowledge graph for voice state.

---

## Migration Path

When this spec ships:

1. Existing `coordinator.yaml` persona fields (`display_name`, `tone`, `title`) are read at first startup and used to seed the initial `office_identity_versions` record
2. The coordinator system prompt is updated to use `${office_identity_block}`
3. The old `persona.*` fields are removed from `coordinator.yaml` in the same PR

---

## Files

| Path | Change |
|------|--------|
| `src/identity/defaults.ts` | New — `DEFAULT_OFFICE_IDENTITY` seed for first boot |
| `src/identity/service.ts` | New — `OfficeIdentityService` (DB-first; no file I/O) |
| `src/identity/types.ts` | New — `OfficeIdentity`, `OfficeIdentityVersion` interfaces |
| `src/db/migrations/013_office_identity.sql` | New — `office_identity_versions`, `office_identity_current` tables |
| `src/channels/http/routes/identity.ts` | New — HTTP API routes |
| `src/index.ts` | Updated — initialize `OfficeIdentityService` before coordinator boots |
| `agents/coordinator.yaml` | Updated — replace `persona.*` with `${office_identity_block}` token |
| `src/agents/loader.ts` | Updated — inject `office_identity_block` at runtime |
