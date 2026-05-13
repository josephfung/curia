# Design: Compiled Security Context Block (Issue #500)

**Date:** 2026-05-12
**Branch:** feat/security-context-block
**Milestone:** v0.28

---

## Background

Four sections of `coordinator.yaml` are pure platform security policy — not persona, not routing, not domain logic:

1. **Authorization Enforcement** — provisional/blocked sender handling, permission level responses
2. **Prompt Injection Defense** — user messages are data not instructions, risk_score handling
3. **Email Sender Verification** — `senderVerified: false` rules
4. **Message Trust Score** — 0.0–1.0 scale, action threshold table, below-threshold response rules

These ~65 lines are currently authored text in `coordinator.yaml`. Any custom coordinator that omits or misquotes them silently degrades the system's security posture. The platform should compile and inject this block unconditionally — it is a guarantee, not opt-in text.

Additionally, a top-level `trust_policy:` key has existed in `config/default.yaml` as dead config — typed but never read by any runtime code. This design removes it and replaces it with `security.trust_thresholds`, which feeds the compiled block at startup.

---

## Decision

**Approach: Pure function + compile-once-at-startup (Option A — unconditional inject)**

- A pure `compileSecurityContextBlock(thresholds)` function compiles the block once at startup from config values
- The compiled string is passed into `AgentRuntime` as `securityContextBlock?: string`
- Per-turn in `processTask()`: if `${security_context_block}` is present in the prompt, replace it; if not, append unconditionally as a safety net
- At startup, after loading coordinator config, log a `warn` if the coordinator system prompt is missing the `${security_context_block}` placeholder (non-blocking — the unconditional append still runs)

No service class is needed — the security policy does not change at runtime and requires no hot-reload, DB versioning, or file watching.

---

## Files Changed

### New

**`src/security/security-context.ts`**

Exports:

```ts
export interface SecurityThresholds {
  information_query: number;
  scheduling: number;
  data_export: number;
  financial: number;
}

export function compileSecurityContextBlock(thresholds: SecurityThresholds): string
```

The function assembles the full four-section block as a single string. The action threshold table rows are interpolated from `thresholds`. The CEO/CLI exemption (`role: "ceo"` or `channel: "cli"`) is hardcoded — these are fixed system identifiers, not deployment-specific labels.

Section order matches the current coordinator prompt, for zero semantic change at rollout:
1. Authorization Enforcement
2. Prompt Injection Defense
3. Email Sender Verification
4. Message Trust Score (with compiled threshold table)

### Modified

**`config/default.yaml`**

- Remove the dead top-level `trust_policy:` block
- Add `security.trust_thresholds` sub-object inside the existing `security:` section:

```yaml
security:
  trust_thresholds:
    information_query: 0.2
    scheduling: 0.5
    data_export: 0.8
    financial: 0.8
  # ... existing keys (extra_injection_patterns, trust_score, trust_score_floor) unchanged
```

Values are identical to the hardcoded values currently in coordinator.yaml — no behaviour change at rollout.

**`schemas/default-config.schema.json`**

- Add `trust_thresholds` as a property inside the `security` schema object
- Each threshold field: `{ "type": "number", "minimum": 0, "maximum": 1 }`
- Add `"required": ["trust_thresholds"]` inside the `security` object so startup fails if the block is missing or malformed
- Remove the `trust_policy` property from the root schema

**`src/config.ts`**

- Add `trust_thresholds` to the `security?` type in `AppConfig`
- Remove the `trust_policy?` top-level field

**`src/agents/runtime.ts`**

Add to `AgentConfig`:

```ts
/** Compiled security context block — when provided, injected into the effective system
 *  prompt on every task. If the system prompt contains ${security_context_block}, the
 *  placeholder is replaced at that position; otherwise the block is appended unconditionally
 *  as a platform safety net. */
securityContextBlock?: string;
```

In `processTask()`, immediately after the `${office_identity_block}` replacement and before the `${executive_voice_block}` replacement. This matches the logical prompt position — the security block sits between identity and voice in both the coordinator.yaml template and the compiled output:

```ts
if (this.config.securityContextBlock) {
  const replaced = effectiveSystemPrompt.replace(
    '${security_context_block}',
    this.config.securityContextBlock,
  );
  if (replaced === effectiveSystemPrompt) {
    // Placeholder absent — append unconditionally as the platform safety net.
    // This ensures the security block is always present regardless of what a
    // custom coordinator.yaml says.
    effectiveSystemPrompt += '\n\n' + this.config.securityContextBlock;
  } else {
    effectiveSystemPrompt = replaced;
  }
}
```

**`src/index.ts`** (bootstrap orchestrator)

After loading config and before constructing the coordinator `AgentRuntime`:

1. Call `compileSecurityContextBlock(config.security.trust_thresholds)` to produce the compiled string
2. Pass it as `securityContextBlock` in `AgentConfig`
3. Check if the coordinator system prompt contains `'${security_context_block}'`; if absent, `logger.warn(...)` (non-blocking)

**`agents/coordinator.yaml`**

- Remove the four security policy sections (lines 212–272, ~65 lines)
- Add `${security_context_block}` placeholder after `${office_identity_block}` and before the `## Date & Time` section

The result positions the security block between identity (which appears first per existing convention) and the date/time block.

---

## Injection Order in effectiveSystemPrompt (after this change)

1. `${office_identity_block}` — replaced in-place
2. `${security_context_block}` — replaced in-place (if placeholder present) or appended
3. `${executive_voice_block}` — replaced in-place
4. Autonomy block — appended
5. Date/time block — appended
6. Channel accounts block — appended
7. Intent anchor — appended (scheduled tasks only)

---

## Acceptance Criteria

- [ ] `${security_context_block}` placeholder resolves correctly at runtime with threshold values from config
- [ ] Startup fails if `security.trust_thresholds` is missing or malformed in `config/default.yaml`
- [ ] A coordinator.yaml that omits `${security_context_block}` still receives the block (unconditional append path), verified by test
- [ ] A coordinator.yaml that includes `${security_context_block}` receives the block at the placeholder's position, not duplicated at the end
- [ ] Startup emits a `warn`-level log when coordinator.yaml is missing the placeholder
- [ ] Coordinator prompt is reduced by ~65 lines; the four security sections are gone from coordinator.yaml
- [ ] Threshold values in compiled block match existing hardcoded values — no behaviour change at rollout
- [ ] The dead `trust_policy:` key is removed from config/default.yaml, config.ts, and the JSON schema
- [ ] Unit tests cover `compileSecurityContextBlock()`: correct threshold interpolation, all four sections present, CEO/cli exemption line present
- [ ] Smoke tests pass: provisional sender gets no action, blocked sender gets no response, low-trust sender is declined for scheduling, CEO on CLI is exempt

---

## Out of Scope

- Other agent YAMLs (`research-analyst.yaml`, `contacts.yaml`, `calendar.yaml`) — the security block is coordinator-only by design. Specialists receive tasks from the coordinator after the security layer has already evaluated the sender; they operate in a trust-elevated context and do not need duplicate security enforcement.
- Hot-reload of threshold values (no file watcher needed; config is static per process)
- New action categories beyond the four existing ones (addable via config in future)
