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

Specialist agents do not have personalities. They have task-specific posture. Only the Coordinator expresses the office identity outward.

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
| `assistant.email_signature` | multiline string | Full email sign-off block |
| `tone.baseline` | string[] (1–3 items) | Tone descriptors chosen from the predefined set; compiled to "Your tone is X, Y, and Z." Stored as a string array, validated at the application layer — not a DB enum, so the set can be extended without a migration |
| `tone.verbosity` | integer 0–100 | 0 = tersest, 100 = most thorough; `compileSystemPromptBlock()` translates to prose guidance |
| `tone.directness` | integer 0–100 | 0 = most hedged, 100 = most direct; compiled to prose guidance |
| `behavioral_preferences` | string[] | Ordered list of behavioral rules compiled into system prompt |
| `decision_style.external_actions` | enum | Risk posture for actions that affect the outside world |
| `decision_style.internal_analysis` | enum | Risk posture for internal analysis and synthesis |
| `constraints` | string[] | Hard rules placed before all other identity content; cannot be overridden |

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
    // 1–3 words from BASELINE_TONE_OPTIONS. Validated at the application layer.
    // Not a DB enum — extend BASELINE_TONE_OPTIONS without a migration.
    baseline: string[];
    verbosity: number;   // 0–100; 0 = tersest, 100 = most thorough
    directness: number;  // 0–100; 0 = most hedged, 100 = most direct
  };
  behavioralPreferences: string[];
  decisionStyle: {
    externalActions: 'conservative' | 'balanced' | 'proactive';
    internalAnalysis: 'conservative' | 'balanced' | 'proactive';
  };
  constraints: string[];
}

// Predefined set for tone.baseline. Validated at the application layer.
// To add a new word: extend this constant and bump the app — no migration needed.
const BASELINE_TONE_OPTIONS = [
  // Warmth / Relationship
  'warm', 'friendly', 'approachable', 'personable', 'empathetic',
  'encouraging', 'gracious', 'caring',
  // Efficiency / Edge
  'direct', 'blunt', 'candid', 'frank', 'matter-of-fact', 'no-nonsense',
  // Energy / Register
  'energetic', 'calm', 'composed', 'enthusiastic', 'steady', 'measured',
  // Personality / Color
  'playful', 'witty', 'dry', 'charming', 'diplomatic', 'tactful',
  'thoughtful', 'curious',
  // Authority / Gravitas
  'confident', 'assured', 'polished', 'authoritative', 'professional',
] as const;

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
3. Tone guidance (baseline + verbosity + directness)
4. Decision style guidance
5. Behavioral preferences (ordered list)

`tone.verbosity` and `tone.directness` are scalar integers. The compiler maps them to prose guidance using approximate bands — these are guidelines, not hard cutoffs:

| Score | Verbosity guidance | Directness guidance |
|-------|--------------------|---------------------|
| 0–25 | Keep responses as brief as possible; omit context unless asked | Be measured; acknowledge uncertainty with appropriate qualification |
| 26–50 | Default to concise responses; expand when detail is clearly needed | Lean toward directness but hedge where genuinely uncertain |
| 51–75 | Adapt response length to what the situation calls for | Be direct; minimize unnecessary hedging and qualification |
| 76–100 | Default to thorough explanations; err toward more context | State positions plainly; avoid softening language |

`tone.baseline` maps to a short prose descriptor: `direct` → "clear and efficient", `balanced` → "professional but warm", `warm` → "friendly and relationship-forward".

Example output (default config — baseline: `["warm", "direct"]`, verbosity: `50`, directness: `75`):

```
## Identity & Communication Contract

**Hard constraints (non-negotiable):**
- Never impersonate the CEO
- Always identify as an AI assistant when asked directly

**Who you are:**
You are Alex Curia, Executive Assistant to the CEO.

**Communication style:**
Your tone is warm and direct.
Adapt response length to what the situation calls for.
Be direct; minimize unnecessary hedging and qualification.

**Decision posture:**
For external actions, be conservative — verify before acting.
For internal analysis, be proactive — surface insights without being asked.

**Behavioral preferences:**
- Be concise unless detail is explicitly requested
- Prioritize signal over noise — surface only what's actionable or strategic
- Escalate ambiguity before taking external action
```

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

The `behavioralPreferences` array is populated through two paths:

1. **Form wizard at `/setup`** — step 3 ("Posture") includes a free-form
   textarea. Submitting step 4 calls `PUT /api/identity` with the wizard's
   compiled identity payload, including any new preferences appended to
   the existing array. See [spec 18 — Onboarding](18-onboarding.md#layer-2--form-wizard-at-setup).

2. **`behavioral-preferences-update` skill** — invoked by the `setup-wizard`
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

## Implementation Status

| Item | Status |
|---|---|
| `src/identity/defaults.ts` — `DEFAULT_OFFICE_IDENTITY` seed | Done |
| Migration: `office_identity_versions` and `office_identity_current` tables | Done |
| `OfficeIdentityService` — load, cache, update, history, compile | Done |
| `src/identity/types.ts` — `OfficeIdentity` and `OfficeIdentityVersion` interfaces | Done |
| HTTP routes — `GET/PUT /api/identity`, `GET /api/identity/history`, `POST /api/identity/reload` | Done |
| Hot reload — `POST /api/identity/reload` (wizard-driven; no file watcher) | Done |
| `compileSystemPromptBlock()` — constraints → identity → tone → decision style → preferences | Done |
| Coordinator integration — `${office_identity_block}` token injected at runtime | Done |
| Audit events — `config.change` emitted on every identity update | Done |
| DB load precedence at startup (DB → in-code defaults seed) | Done |
| `behavioral-preferences-update` skill — append/replace via `officeIdentityService` capability | Done |

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
