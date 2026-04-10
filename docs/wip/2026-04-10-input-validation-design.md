# Input Validation: Message Size Limits, Config Schema Validation, and Manifest Validation

**Issue:** [#196](https://github.com/josephfung/curia/issues/196)
**Date:** 2026-04-10

## Overview

Implement input validation at four system boundaries:

1. **Inbound message size limiting** — dispatcher rejects oversized messages before routing
2. **`config/default.yaml` validation** — JSON Schema check at startup
3. **Agent YAML config validation** — JSON Schema check at startup
4. **Skill manifest validation** — JSON Schema check at startup

All four are enforced by a centralized startup validator (`src/startup/validator.ts`) plus a dispatcher-level size check. Invalid config causes a loud startup failure (`process.exit(1)`) rather than silent misbehavior at runtime.

---

## Design Decisions

### Centralized startup validator

All schema-based validation is orchestrated by a single `src/startup/validator.ts` called early in `index.ts` — before the DB connection, before any service is initialized. This is the right place for "fail fast" checks:

- Single call site in the bootstrap sequence
- Future startup checks (e.g., DB connectivity, LLM provider reachability) can be added here as the system grows
- Errors surface before any side-effectful initialization

### JSON Schema with Ajv + dedicated schema files

Schema definitions live in `schemas/` (project root) as `.schema.json` files. Ajv is used for validation with `allErrors: true` so all violations in a file are reported at once.

**Why schema files over inline constants:**
- Schema files are legible without reading TypeScript
- Easier to maintain and audit independently
- Can be validated with third-party JSON Schema tools
- A natural home for documentation about each field's constraints

### Message size check in the dispatcher (not channel adapters)

The spec mentions "channel layer" rejection, but enforcing the check in each channel adapter would require expanding the channel layer's bus publish permissions (`message.rejected` is currently a dispatch-layer event). Doing it in the dispatcher instead:

- Avoids permission boundary expansion
- Creates a clean causal chain in the audit log: `inbound.message` (parentEventId) → `message.rejected`
- Single enforcement point — future channel adapters get the check for free
- The oversized content briefly enters the bus (in-process memory only), which is acceptable and actually gives forensic value in the audit log

### `config/default.yaml` validation (scope expansion beyond issue #196)

The issue only specifies agent YAML and skill manifest validation, but `config/default.yaml` carries numeric thresholds (trust score weights, policy thresholds) that are currently unvalidated. A misconfigured value (e.g., a string where a number is expected, or a trust threshold above 1.0) fails silently and is difficult to diagnose. Since we're adding Ajv and a schemas directory anyway, the marginal cost of covering `default.yaml` is low and the benefit is high.

---

## New Files

### `src/schemas/agent-config.schema.json`

JSON Schema for `agents/*.yaml` files.

Required fields: `name`, `description`, `model.provider`, `model.model`, `system_prompt`

Optional typed fields: `role`, `persona` (object with optional `display_name`, `tone`, `title`, `email_signature`), `pinned_skills` (array of strings), `allow_discovery` (boolean), `memory.scopes` (array of strings), `schedule` (array of objects), `error_budget` (object with optional numeric fields).

`additionalProperties: false` at the top level and all nested objects — catches YAML key typos that would otherwise be silently ignored.

### `src/schemas/skill-manifest.schema.json`

JSON Schema for `skills/*/skill.json` files.

Required fields: `name` (string), `description` (string), `version` (string), `action_risk` (string enum `none|low|medium|high|critical` OR integer 0–100).

Optional fields: `sensitivity` (enum: `normal|elevated`), `inputs` (object), `outputs` (object), `permissions` (array of strings), `secrets` (array of strings), `timeout` (integer ≥ 1), `infrastructure` (boolean), `entity_enrichment` (object with `param` string and `default` enum `caller|agent`).

Handler path is not a schema field — the loader verifies `handler.ts`/`handler.js` exists on disk, which is the correct approach for a filesystem-derived property.

`additionalProperties: false` throughout.

### `src/schemas/default-config.schema.json`

JSON Schema for `config/default.yaml`. All fields are optional (the file is intentionally partial — defaults are applied in code). When fields are present, types and ranges are enforced.

Key constraints:
- `channels.maxMessageBytes`: integer, minimum 1
- `security.trust_score.channel_weight`: number, minimum 0, maximum 1
- `security.trust_score.contact_weight`: number, minimum 0, maximum 1
- `security.trust_score.max_risk_penalty`: number, minimum 0, maximum 1
- `security.trust_score_floor`: number, minimum 0, maximum 1
- `trust_policy.financial_actions`: number, minimum 0, maximum 1
- `trust_policy.data_export`: number, minimum 0, maximum 1
- `trust_policy.scheduling`: number, minimum 0, maximum 1
- `trust_policy.information_queries`: number, minimum 0, maximum 1
- `workingMemory.summarization.threshold`: integer, minimum 2
- `workingMemory.summarization.keepWindow`: integer, minimum 1
- `skillOutput.maxLength`: integer, minimum 1
- `browser.sessionTtlMs`: integer, minimum 1
- `browser.sweepIntervalMs`: integer, minimum 1
- `dispatch.conversationCheckpointDebounceMs`: integer, minimum 1

`additionalProperties: false` at every nesting level catches typos like `trust-policy` instead of `trust_policy`.

### `src/startup/validator.ts`

```typescript
export async function runStartupValidation(opts: {
  configDir: string;
  agentsDir: string;
  skillsDir: string;
  logger: Logger;
}): Promise<void>
```

Execution order:
1. Load and validate `config/default.yaml` against `default-config.schema.json`
2. Load and validate each `agents/*.yaml` file against `agent-config.schema.json`
3. Load and validate each `skills/*/skill.json` file against `skill-manifest.schema.json`

On validation failure: throws with a descriptive message that includes the file path and all failing field paths/messages (Ajv `allErrors: true` collects all errors before throwing).

The Ajv instance is created once and schemas are compiled once — not recreated per file. This keeps startup fast even with many agents/skills.

---

## Modified Files

### `config/default.yaml`

Add `maxMessageBytes` to the `channels` section:

```yaml
channels:
  cli:
    enabled: true
  maxMessageBytes: 102400   # 100KB — inbound messages exceeding this are rejected before routing
```

### `src/config.ts`

Add `maxMessageBytes` to the `YamlConfig.channels` type:

```typescript
channels?: {
  cli?: { enabled?: boolean };
  maxMessageBytes?: number;
};
```

### `src/index.ts`

1. Call `runStartupValidation()` immediately after config and logger are initialized, before DB connection:

```typescript
await runStartupValidation({
  configDir,
  agentsDir: path.resolve(import.meta.dirname, '../agents'),
  skillsDir: path.resolve(import.meta.dirname, '../skills'),
  logger,
});
```

2. Pass `maxMessageBytes` into `DispatcherConfig`:

```typescript
maxMessageBytes: yamlConfig.channels?.maxMessageBytes ?? 102_400,
```

### `src/agents/loader.ts`

Remove the manual field checks (`if (!config.name)`, `if (!config.model?.provider)`, etc.) — these are now enforced by the startup validator's Ajv schema check, which runs before the loaders are called. The loader retains YAML parse error handling and persona interpolation logic, which are not schema concerns.

### `src/skills/loader.ts`

Same: remove the manual `if (!manifest.name || !manifest.description)` check. Ajv now enforces all required fields. The loader retains handler discovery (`handler.ts`/`handler.js`) and dynamic import logic.

### `src/bus/events.ts`

Add `'message_too_large'` to the `reason` union in `MessageRejectedPayload`:

```typescript
reason: 'unknown_sender' | 'provisional_sender' | 'blocked_sender' | 'message_too_large';
```

This is a change to a public API surface (`bus/events.ts`) and must be called out in the CHANGELOG.

### `src/dispatch/dispatcher.ts`

Add `maxMessageBytes` to `DispatcherConfig`. In the `inbound.message` handler, before contact resolution:

```typescript
const contentByteSize = Buffer.byteLength(event.payload.content, 'utf-8');
if (contentByteSize > this.maxMessageBytes) {
  this.logger.warn(
    { channelId: event.payload.channelId, senderId: event.payload.senderId,
      contentByteSize, maxBytes: this.maxMessageBytes },
    'Inbound message exceeded size limit — rejected',
  );
  await this.bus.publish('dispatch', createMessageRejected({
    conversationId: event.payload.conversationId,
    channelId: event.payload.channelId,
    senderId: event.payload.senderId,
    reason: 'message_too_large',
    parentEventId: event.id,
  }));
  return;
}
```

The `message.rejected` event is already in the dispatch layer's publish permissions — no permission changes needed.

---

## Message Size Rejection Behavior

- **All channels:** silent drop — no response sent to the sender
- **Email specifically:** consistent with the unknown sender policy (`ignore`) — no auto-reply
- **Audit trail:** the `inbound.message` event is written to audit_log before dispatch (write-ahead), and the `message.rejected` event follows with `parentEventId` pointing to the oversized `inbound.message`. Both records are in the audit log.
- **Configurable:** `channels.maxMessageBytes` in `config/default.yaml`. Default: `102400` (100KB). The schema enforces this is an integer ≥ 1.

---

## Testing

### Unit tests (new)

**`tests/unit/startup/validator.test.ts`**
- Valid agent YAML → no error
- Agent YAML missing `name` → throws with file path and field name
- Agent YAML missing `description` → throws
- Agent YAML missing `model.provider` → throws
- Agent YAML with unknown top-level key → throws (additionalProperties)
- Valid skill manifest → no error
- Skill manifest missing `version` → throws
- Skill manifest missing `action_risk` → throws
- Skill manifest with invalid `action_risk` value → throws
- Valid `default.yaml` → no error
- `default.yaml` with `trust_score_floor: 1.5` → throws (out of range)
- `default.yaml` with `maxMessageBytes: "big"` → throws (wrong type)
- `default.yaml` with unknown key → throws (additionalProperties)

**`tests/unit/dispatch/dispatcher.test.ts`** (additions to existing file)
- Message with content ≤ maxMessageBytes → routes normally
- Message with content > maxMessageBytes → publishes `message.rejected`, does not publish `agent.task`
- Rejection event has correct `parentEventId` pointing to the inbound message

### Manual verification at startup

With a deliberately broken `agents/coordinator.yaml` (remove `description` field), startup should exit with a message like:

```text
Fatal: Startup validation failed for agents/coordinator.yaml:
  - /description: must have required property 'description'
```

---

## Acceptance Criteria (from issue #196)

- [x] Inbound messages exceeding 100KB are rejected before bus routing; rejection is audit-logged
- [x] Max message size is configurable in `config/default.yaml` as `channels.maxMessageBytes`
- [x] Bootstrap orchestrator validates all `agents/*.yaml` files against JSON Schema at startup
- [x] Bootstrap orchestrator validates all `skills/*/skill.json` manifests against JSON Schema at startup
- [x] Invalid config or manifest causes process exit with a descriptive error (not a silent failure)
- [x] Dispatch policy rules (`trust_policy.*`, `security.trust_score.*`) validated at load time
- [x] Unit tests: oversized message → rejected; invalid agent YAML → startup error; invalid manifest → startup error
