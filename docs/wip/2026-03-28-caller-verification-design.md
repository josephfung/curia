# Caller Verification for Elevated Skills

**Issue:** #44
**Date:** 2026-03-28
**Status:** Approved

## Problem

The three permission-management skills (`contact-grant-permission`, `contact-revoke-permission`, `contact-set-role`) rely on LLM prompt-following to ensure only the CEO triggers them. There is no programmatic enforcement. A prompt injection via email could trick the coordinator into granting permissions to a malicious contact.

Additionally, `ContactService.grantPermission()` hardcodes `grantedBy: 'ceo'` regardless of who actually initiated the action, making the audit trail unreliable.

`contact-set-role` is currently `sensitivity: "normal"` despite being able to assign the `"ceo"` role — it should be `"elevated"`.

## Approach

Pass caller context through `ExecutionLayer.invoke()`. The execution layer enforces a gate on `sensitivity: "elevated"` skills before running the handler. Skills receive the caller identity in `SkillContext` for audit fields like `grantedBy`.

This was chosen over two alternatives:
- **Per-handler enforcement** — each skill checks authorization itself. Rejected because security enforcement would be scattered and easy to forget.
- **Bus event lookup** — execution layer traces back to `agent.task` to find `senderContext`. Rejected because it requires bus event lookup by ID (not supported) and adds coupling.

## Design

### 1. New type: `CallerContext`

Added to `src/skills/types.ts`:

```typescript
interface CallerContext {
  /** 'primary-user' for CLI, actual contact ID otherwise */
  contactId: string;
  /** 'ceo', 'cfo', null, etc. */
  role: string | null;
  /** Originating channel: 'cli', 'email', 'signal', etc. */
  channel: string;
}
```

Intentionally minimal — no KG facts, no authorization result, no display name. The execution layer needs role + channel for the gate decision; skills need `contactId` for audit.

### 2. Execution layer gate

`ExecutionLayer.invoke()` gets a new optional parameter `caller?: CallerContext`. For `sensitivity: "elevated"` skills, the gate runs before building the skill context:

1. If `caller` is undefined: **REJECT** (fail-closed — no caller context means no elevated skills)
2. If `caller.role === 'ceo'`: **ALLOW**
3. If `caller.channel === 'cli'`: **ALLOW** (CLI is always the primary user; defense-in-depth)
4. Otherwise: **REJECT** with a clear error message

Normal skills are unaffected — they run with or without caller context.

Rejected result format:
```
{ success: false, error: "Skill 'contact-grant-permission' requires elevated privileges — caller role 'cfo' on channel 'email' is not authorized" }
```

### 3. Wiring through the agent runtime

The agent runtime (the only call site for `executionLayer.invoke()`) extracts caller context from the task event:

```typescript
const senderCtx = taskEvent.payload.senderContext;
const caller = senderCtx?.resolved
  ? { contactId: senderCtx.contactId, role: senderCtx.role, channel: taskEvent.payload.channelId }
  : undefined;

const result = await executionLayer.invoke(toolCall.name, toolCall.input, caller);
```

Channel comes from `AgentTaskPayload.channelId`, not from `senderContext` (which doesn't carry channel — it's about the contact, not the message).

Unresolved senders produce `caller = undefined`, which triggers the fail-closed gate on elevated skills. This is correct — unknown senders should never trigger permission changes.

### 4. SkillContext extension

`SkillContext` gets a new optional field `caller?: CallerContext`. Populated for all skills (elevated or normal) so any skill can read it. This is how `contact-grant-permission` gets the real caller identity.

### 5. Skill-side changes

**`contact-grant-permission` handler:** Uses `ctx.caller!.contactId` instead of hardcoded `'ceo'` for the `grantedBy` field. The non-null assertion is safe here because the execution layer gate guarantees `caller` is defined for elevated skills — if it weren't, the skill would never execute.

**`ContactService.grantPermission()`:** Accepts a `grantedBy` parameter instead of hardcoding it.

**`contact-set-role` manifest:** Change `sensitivity` from `"normal"` to `"elevated"`.

**`contact-revoke-permission` handler:** No changes needed. The execution layer gate already protects it, and `revokePermission()` has no `grantedBy` field.

### 6. What does NOT change

- `ContactService.revokePermission()` — no `grantedBy` tracking on revocations
- `AuthorizationService` — deterministic evaluation logic is unrelated
- `ContactResolver` — already produces the `senderContext` we need
- Bus events / permissions — no new event types, no layer permission changes
- Normal skills — completely unaffected

## Testing

- **Execution layer unit tests:** elevated skill + CEO caller passes; elevated skill + non-CEO caller rejected; elevated skill + no caller rejected (fail-closed); normal skill + no caller passes
- **Grant-permission handler test:** verify `grantedBy` reflects actual caller, not hardcoded `'ceo'`
- **Set-role manifest:** verify sensitivity is `"elevated"`
- **Integration/smoke test:** CLI path works end-to-end (CLI -> CEO senderContext -> elevated skill allowed)

## Files to modify

| File | Change |
|------|--------|
| `src/skills/types.ts` | Add `CallerContext` interface, add `caller?` to `SkillContext` |
| `src/skills/execution.ts` | Add `caller?` param to `invoke()`, add elevated-skill gate |
| `src/agents/runtime.ts` | Extract `CallerContext` from `taskEvent`, pass to `invoke()` |
| `src/contacts/contact-service.ts` | `grantPermission()` accepts `grantedBy` param |
| `skills/contact-grant-permission/handler.ts` | Pass `ctx.caller?.contactId` as `grantedBy` |
| `skills/contact-set-role/skill.json` | Change `sensitivity` to `"elevated"` |
| Tests for execution layer | New tests for the gate logic |
| Tests for grant-permission handler | Verify `grantedBy` is caller-derived |
