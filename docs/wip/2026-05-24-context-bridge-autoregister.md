# Context Bridge Auto-Registration

**Issue:** [#609](https://github.com/josephfung/curia/issues/609)
**Date:** 2026-05-24
**Status:** Design approved, implementation pending

## Problem

Context bridging v2 (PR #678) built the read side correctly — the dispatcher
injects `[ACTIVE OUTBOUND CONTEXT]` blocks on every inbound message from the
`outbound_context` table. But the write side is opt-in: send skills only
register an entry when the caller passes an explicit `context_bridge` JSON
param. Nothing in the system currently passes it, so the table stays empty and
the coordinator loses context on proactive outbounds.

## Solution

Make outbound context registration unconditional. Every successful send through
`signal-send`, `email-send`, or `email-reply` registers an entry in the
`outbound_context` table — whether or not `context_bridge` was explicitly
passed.

## Design

### 1. New unified function in `context-bridge-parse.ts`

```typescript
export async function registerOutboundContext(
  outboundContext: OutboundContextCapability | undefined,
  contextBridgeRaw: unknown,
  opts: {
    channelId: string;
    content: string;
    agentId: string;
    log: Logger;
  },
): Promise<void>
```

Behavior:
- If `outboundContext` is undefined → no-op (graceful when capability unavailable)
- Parses `contextBridgeRaw` via existing `parseContextBridge` logic
- If parsed successfully → registers with explicit metadata; TTL is
  `bridge.expires_in_hours ?? outboundContext.explicitExpiryHours`
- If absent/null/malformed → registers minimal entry (agentId + channelId + content);
  TTL is `outboundContext.defaultExpiryHours`
- Never throws — logs warnings on failure

TTL values are read from `outboundContext.defaultExpiryHours` and
`outboundContext.explicitExpiryHours` — exposed as readonly properties on the
`OutboundContextCapability` interface (see section 3 below).

Existing `parseContextBridge` and `registerContextBridge` exports are preserved
(they're tested and may be referenced elsewhere).

### 2. Send skill handler changes

Each of the 3 send skills replaces:
```typescript
const bridge = parseContextBridge(contextBridgeRaw, ctx.log);
if (bridge) {
  await registerContextBridge(ctx.outboundContext, bridge, 'signal', message, ctx.log);
}
```

With:
```typescript
await registerOutboundContext(ctx.outboundContext, contextBridgeRaw, {
  channelId: 'signal',  // or 'email'
  content: message,
  agentId: ctx.agentId ?? 'coordinator',
  log: ctx.log,
});
```

TTL values come from `ctx.outboundContext.defaultExpiryHours` and
`ctx.outboundContext.explicitExpiryHours` — the utility reads them directly
from the capability. Skills don't need config access.

Registration happens only after a successful gateway send (same position as
today's conditional write).

### 3. Configuration and capability interface

**New config keys** under `contextBridge`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `contextBridge.defaultExpiryHours` | integer (>= 1) | 6 | TTL for auto-registered entries (no `context_bridge` param) |
| `contextBridge.explicitExpiryHours` | integer (>= 1) | 24 | TTL for entries with explicit `context_bridge` metadata |

A caller-specified `expires_in_hours` inside the `context_bridge` JSON always
takes precedence over the configured `explicitExpiryHours`.

**Config flow:** YAML → `src/config.ts` → `src/index.ts` bootstrap →
`OutboundContextService` constructor → `ScopedOutboundContext` → skill context.

**Capability interface change** (`OutboundContextCapability`):

```typescript
export interface OutboundContextCapability {
  register(entry: Omit<OutboundContextEntry, 'conversationId'>): Promise<string>;
  release(entryId: string): Promise<void>;
  readonly defaultExpiryHours: number;   // NEW
  readonly explicitExpiryHours: number;  // NEW
}
```

`ScopedOutboundContext` exposes these as readonly properties, reading from the
service which receives them at construction. The `registerOutboundContext`
utility reads them from the capability — skills never touch config directly.

**Files to update:**
- `src/config.ts` — add to `YamlConfig` interface + validation
- `schemas/default-config.schema.json` — add property definition
- `config/default.yaml` — add commented example
- `docs/dev/configuration.md` — document both keys
- `src/dispatch/outbound-context.ts` — constructor accepts config; replaces
  `DEFAULT_EXPIRY_HOURS` constant; `ScopedOutboundContext` exposes TTL properties
- `src/index.ts` — pass config values to `OutboundContextService` constructor

### 4. Coordinator prompt update

Add to `agents/coordinator.yaml` after the "Active Outbound Context &
Delegation" section:

```
### Enriching outbound context
When you call signal-send, email-send, or email-reply and you know which
specialist should handle any reply, pass the context_bridge parameter:

  context_bridge: {"agent_id": "coordinator", "delegation_hint": "calendar-specialist", "expected_reply": "confirmation or reschedule request"}

This is optional — every outbound message is automatically tracked. But passing
context_bridge adds delegation hints that help you route replies faster without
needing to re-derive context.
```

### 5. TTL strategy

- Auto-registered (6h default): covers the common reply window without
  accumulating stale noise
- Explicit (24h default): richer metadata, intentionally set up by caller,
  deserves longer life
- Caller `expires_in_hours` overrides both (for special cases)
- No opt-out mechanism — every outbound is tracked
- Existing `cleanupExpired()` and `context-bridge-release` handle lifecycle

### 6. What is NOT changing

- `OutboundGateway` — stays pure transport, no new dependencies
- `src/dispatch/dispatcher.ts` — injection logic (read side) unchanged
- `context-bridge-release` skill — unchanged
- `skill.json` manifests — `context_bridge` input stays optional
- `OutboundContextService.register()` method signature — unchanged
  (service already accepts `expiresInHours` per entry)
- `OutboundContextService.getActive()` / `formatInjectionBlock()` — unchanged

## Testing

### Unit tests (`context-bridge-parse.ts`)
- `registerOutboundContext` with no `context_bridge` → registers minimal entry with default TTL
- `registerOutboundContext` with valid JSON → registers with explicit metadata + explicit TTL
- `registerOutboundContext` with malformed JSON → falls back to auto-registration, logs warning
- `registerOutboundContext` with `expires_in_hours` in JSON → uses caller-specified TTL
- `registerOutboundContext` when capability undefined → no-op, no throw

### Unit tests (send skill handlers)
- Each skill: successful send without `context_bridge` → entry registered
- Each skill: successful send with `context_bridge` → entry has delegation metadata
- Each skill: failed send → no entry registered

### Config tests
- Custom `contextBridge.defaultExpiryHours` respected for auto-registered entries
- Custom `contextBridge.explicitExpiryHours` respected for explicit entries
- Caller `expires_in_hours` overrides configured values
- Schema validation rejects non-integer / < 1 values

### Integration test
- Scheduled job → `signal-send` (no `context_bridge`) → entry in table →
  inbound on that channel → dispatcher injects `[ACTIVE OUTBOUND CONTEXT]`
  block referencing the proactive message

### Regression
- All 55 existing context bridging tests pass unchanged
