# Context Bridge Auto-Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make outbound context registration unconditional — every successful send registers an entry, closing the write-side gap in context bridging v2.

**Architecture:** Modify `OutboundContextCapability` to expose configurable TTL defaults, add a unified `registerOutboundContext` utility that always registers (using explicit metadata when provided, minimal fallback otherwise), update the 3 send skills to call it unconditionally, and add config keys for TTL tuning.

**Tech Stack:** TypeScript, Vitest, YAML config, JSON Schema

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/dispatch/outbound-context.ts` | Service + capability interface; gains config-driven TTLs |
| `src/dispatch/context-bridge-parse.ts` | Shared utility; gains `registerOutboundContext` function |
| `skills/signal-send/handler.ts` | Send skill; switches to unconditional registration |
| `skills/email-send/handler.ts` | Send skill; switches to unconditional registration |
| `skills/email-reply/handler.ts` | Send skill; switches to unconditional registration |
| `src/config.ts` | YAML config interface + validation |
| `schemas/default-config.schema.json` | JSON Schema for config validation |
| `config/default.yaml` | Default config values |
| `docs/dev/configuration.md` | Operator documentation |
| `src/index.ts` | Bootstrap wiring |
| `agents/coordinator.yaml` | Coordinator prompt guidance |
| `src/dispatch/context-bridge-parse.test.ts` | Unit tests for new utility |
| `skills/signal-send/handler.test.ts` | Updated skill tests |
| `skills/email-send/handler.test.ts` | Updated skill tests |
| `skills/email-reply/handler.test.ts` | Updated skill tests |

---

### Task 1: Add TTL config to `OutboundContextCapability` and `OutboundContextService`

**Files:**
- Modify: `src/dispatch/outbound-context.ts:49-53` (interface)
- Modify: `src/dispatch/outbound-context.ts:119-123` (constructor)
- Modify: `src/dispatch/outbound-context.ts:128-129` (register method DEFAULT_EXPIRY_HOURS usage)
- Test: `src/dispatch/outbound-context.test.ts`

- [ ] **Step 1: Write the failing test — service uses configured default TTL**

Add to `src/dispatch/outbound-context.test.ts`:

```typescript
it('uses configured defaultExpiryHours when entry omits expiresInHours', async () => {
  const customService = new OutboundContextService(pool, logger, {
    defaultExpiryHours: 6,
    explicitExpiryHours: 24,
  });
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    rows: [{ id: 'id-1' }],
  });

  await customService.register({
    conversationId: 'conv-1',
    channelId: 'signal',
    agentId: 'coordinator',
    content: 'Test message',
    // no expiresInHours — should use defaultExpiryHours (6h)
  });

  const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
  const expiresAt = call[1][7] as Date;
  const hoursFromNow = (expiresAt.getTime() - Date.now()) / 3_600_000;
  expect(hoursFromNow).toBeGreaterThan(5.9);
  expect(hoursFromNow).toBeLessThan(6.1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run src/dispatch/outbound-context.test.ts --reporter=verbose 2>&1 | tail -20`

Expected: FAIL — `OutboundContextService` constructor doesn't accept config options yet.

- [ ] **Step 3: Update the interface and service to accept config**

In `src/dispatch/outbound-context.ts`, add config interface and update the capability interface:

```typescript
// After the MAX_FIELD_LENGTH constant (line 16), add:
/** Configuration for TTL defaults. */
export interface OutboundContextConfig {
  /** TTL for auto-registered entries (no explicit context_bridge). Default: 6. */
  defaultExpiryHours?: number;
  /** TTL for entries with explicit context_bridge metadata. Default: 24. */
  explicitExpiryHours?: number;
}

const FALLBACK_DEFAULT_EXPIRY_HOURS = 6;
const FALLBACK_EXPLICIT_EXPIRY_HOURS = 24;
```

Update `OutboundContextCapability` interface (line 50):

```typescript
/** Narrow interface exposed to skills via the outboundContext capability. */
export interface OutboundContextCapability {
  register(entry: Omit<OutboundContextEntry, 'conversationId'>): Promise<string>;
  release(entryId: string): Promise<void>;
  readonly defaultExpiryHours: number;
  readonly explicitExpiryHours: number;
}
```

Update `OutboundContextService` constructor (line 119):

```typescript
export class OutboundContextService {
  private readonly _defaultExpiryHours: number;
  private readonly _explicitExpiryHours: number;

  constructor(
    private pool: DbPool,
    private logger: Logger,
    config?: OutboundContextConfig,
  ) {
    this._defaultExpiryHours = config?.defaultExpiryHours ?? FALLBACK_DEFAULT_EXPIRY_HOURS;
    this._explicitExpiryHours = config?.explicitExpiryHours ?? FALLBACK_EXPLICIT_EXPIRY_HOURS;
  }

  get defaultExpiryHours(): number { return this._defaultExpiryHours; }
  get explicitExpiryHours(): number { return this._explicitExpiryHours; }
```

Update `register()` method — replace `DEFAULT_EXPIRY_HOURS` with `this._defaultExpiryHours`:

```typescript
  async register(entry: OutboundContextEntry): Promise<string> {
    const preview = truncatePreview(entry.content);
    const expiresAt = new Date(
      Date.now() + (entry.expiresInHours ?? this._defaultExpiryHours) * 3_600_000,
    );
```

Remove the old `const DEFAULT_EXPIRY_HOURS = 24;` line.

- [ ] **Step 4: Update `ScopedOutboundContext` to expose TTL properties**

At the bottom of `src/dispatch/outbound-context.ts`, update the `ScopedOutboundContext` class:

```typescript
export class ScopedOutboundContext implements OutboundContextCapability {
  constructor(
    private service: OutboundContextService,
    private conversationId: string,
  ) {}

  get defaultExpiryHours(): number { return this.service.defaultExpiryHours; }
  get explicitExpiryHours(): number { return this.service.explicitExpiryHours; }

  async register(entry: Omit<OutboundContextEntry, 'conversationId'>): Promise<string> {
    return this.service.register({ ...entry, conversationId: this.conversationId });
  }

  async release(entryId: string): Promise<void> {
    return this.service.release(entryId, this.conversationId);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run src/dispatch/outbound-context.test.ts --reporter=verbose 2>&1 | tail -20`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister add src/dispatch/outbound-context.ts src/dispatch/outbound-context.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister commit -m "feat: add configurable TTLs to OutboundContextService and capability interface"
```

---

### Task 2: Add `registerOutboundContext` to `context-bridge-parse.ts`

**Files:**
- Modify: `src/dispatch/context-bridge-parse.ts`
- Create: `src/dispatch/context-bridge-parse.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/dispatch/context-bridge-parse.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { registerOutboundContext, parseContextBridge } from './context-bridge-parse.js';
import type { OutboundContextCapability } from './outbound-context.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCap(overrides?: Partial<OutboundContextCapability>): OutboundContextCapability {
  return {
    register: vi.fn().mockResolvedValue('entry-id'),
    release: vi.fn().mockResolvedValue(undefined),
    defaultExpiryHours: 6,
    explicitExpiryHours: 24,
    ...overrides,
  };
}

describe('registerOutboundContext', () => {
  it('no-ops when outboundContext is undefined', async () => {
    // Should not throw
    await registerOutboundContext(undefined, null, {
      channelId: 'signal',
      content: 'Hello',
      agentId: 'coordinator',
      log: logger,
    });
  });

  it('registers minimal entry with defaultExpiryHours when context_bridge is absent', async () => {
    const cap = makeCap();
    await registerOutboundContext(cap, undefined, {
      channelId: 'signal',
      content: 'Your held messages',
      agentId: 'coordinator',
      log: logger,
    });

    expect(cap.register).toHaveBeenCalledWith({
      channelId: 'signal',
      agentId: 'coordinator',
      content: 'Your held messages',
      expiresInHours: 6,
    });
  });

  it('registers with explicit metadata and explicitExpiryHours when context_bridge is valid', async () => {
    const cap = makeCap();
    const bridgeJson = JSON.stringify({
      agent_id: 'meeting-debrief',
      expected_reply: 'Notes',
      delegation_hint: 'Delegate to meeting-debrief',
      metadata: { topic: 'sync' },
    });

    await registerOutboundContext(cap, bridgeJson, {
      channelId: 'signal',
      content: 'Any takeaways?',
      agentId: 'coordinator',
      log: logger,
    });

    expect(cap.register).toHaveBeenCalledWith({
      channelId: 'signal',
      agentId: 'meeting-debrief',
      content: 'Any takeaways?',
      expectedReply: 'Notes',
      delegationHint: 'Delegate to meeting-debrief',
      metadata: { topic: 'sync' },
      expiresInHours: 24,
    });
  });

  it('uses caller-specified expires_in_hours over explicitExpiryHours', async () => {
    const cap = makeCap();
    const bridgeJson = JSON.stringify({
      agent_id: 'coordinator',
      expires_in_hours: 48,
    });

    await registerOutboundContext(cap, bridgeJson, {
      channelId: 'email',
      content: 'Important email',
      agentId: 'coordinator',
      log: logger,
    });

    expect(cap.register).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInHours: 48 }),
    );
  });

  it('falls back to auto-registration when context_bridge is malformed JSON', async () => {
    const cap = makeCap();
    await registerOutboundContext(cap, 'not-json{{{', {
      channelId: 'signal',
      content: 'Hello',
      agentId: 'coordinator',
      log: logger,
    });

    expect(cap.register).toHaveBeenCalledWith({
      channelId: 'signal',
      agentId: 'coordinator',
      content: 'Hello',
      expiresInHours: 6,
    });
  });

  it('falls back to auto-registration when context_bridge has missing agent_id', async () => {
    const cap = makeCap();
    await registerOutboundContext(cap, JSON.stringify({ expected_reply: 'hi' }), {
      channelId: 'signal',
      content: 'Hello',
      agentId: 'coordinator',
      log: logger,
    });

    expect(cap.register).toHaveBeenCalledWith({
      channelId: 'signal',
      agentId: 'coordinator',
      content: 'Hello',
      expiresInHours: 6,
    });
  });

  it('does not throw when register() rejects', async () => {
    const cap = makeCap({
      register: vi.fn().mockRejectedValue(new Error('DB down')),
    });

    // Should not throw
    await registerOutboundContext(cap, undefined, {
      channelId: 'signal',
      content: 'Hello',
      agentId: 'coordinator',
      log: logger,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run src/dispatch/context-bridge-parse.test.ts --reporter=verbose 2>&1 | tail -20`

Expected: FAIL — `registerOutboundContext` is not exported from the module yet.

- [ ] **Step 3: Implement `registerOutboundContext`**

Add to the bottom of `src/dispatch/context-bridge-parse.ts`:

```typescript
/**
 * Unified context registration — always registers an entry after a successful send.
 *
 * - If context_bridge JSON is valid: registers with explicit metadata + explicitExpiryHours TTL
 * - If context_bridge is absent/malformed: registers a minimal entry + defaultExpiryHours TTL
 * - Caller-specified expires_in_hours in the bridge JSON overrides explicitExpiryHours
 * - Never throws — logs warnings on failure
 */
export async function registerOutboundContext(
  outboundContext: OutboundContextCapability | undefined,
  contextBridgeRaw: unknown,
  opts: {
    channelId: string;
    content: string;
    agentId: string;
    log: Logger;
  },
): Promise<void> {
  if (!outboundContext) return;

  const bridge = parseContextBridge(contextBridgeRaw, opts.log);

  try {
    if (bridge) {
      // Explicit context_bridge provided — use its metadata + explicit TTL
      await outboundContext.register({
        channelId: opts.channelId,
        agentId: bridge.agent_id,
        content: opts.content,
        ...(bridge.expected_reply != null ? { expectedReply: bridge.expected_reply } : {}),
        ...(bridge.delegation_hint != null ? { delegationHint: bridge.delegation_hint } : {}),
        ...(bridge.metadata != null ? { metadata: bridge.metadata } : {}),
        expiresInHours: bridge.expires_in_hours ?? outboundContext.explicitExpiryHours,
      });
    } else {
      // No explicit bridge — auto-register minimal entry with default TTL
      await outboundContext.register({
        channelId: opts.channelId,
        agentId: opts.agentId,
        content: opts.content,
        expiresInHours: outboundContext.defaultExpiryHours,
      });
    }
  } catch (err) {
    opts.log.warn({ err, channelId: opts.channelId }, 'Failed to register outbound context entry — send succeeded');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run src/dispatch/context-bridge-parse.test.ts --reporter=verbose 2>&1 | tail -30`

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister add src/dispatch/context-bridge-parse.ts src/dispatch/context-bridge-parse.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister commit -m "feat: add registerOutboundContext utility for unconditional context registration"
```

---

### Task 3: Update `signal-send` handler to use unconditional registration

**Files:**
- Modify: `skills/signal-send/handler.ts:5` (import)
- Modify: `skills/signal-send/handler.ts:120-124` (group path registration)
- Modify: `skills/signal-send/handler.ts:146-150` (1:1 path registration)
- Modify: `skills/signal-send/handler.test.ts:221-238` (update "absent" test)

- [ ] **Step 1: Update the test — "absent context_bridge" now DOES register**

In `skills/signal-send/handler.test.ts`, find the test at line 221 "does not register when context_bridge is absent" and replace it:

```typescript
    it('registers a minimal entry when context_bridge is absent', async () => {
      const ctx = makeCtx({
        input: {
          recipient: '+14155551234',
          message: 'Hello',
        },
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'msg-1',
      });
      const mockRegister = vi.fn().mockResolvedValue('entry-1');
      (ctx as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
      };
      (ctx as Record<string, unknown>).agentId = 'coordinator';

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(mockRegister).toHaveBeenCalledWith({
        channelId: 'signal',
        agentId: 'coordinator',
        content: 'Hello',
        expiresInHours: 6,
      });
    });
```

- [ ] **Step 2: Run tests to verify the new test fails**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run skills/signal-send/handler.test.ts --reporter=verbose 2>&1 | tail -30`

Expected: FAIL — handler still uses the conditional `if (bridge)` guard.

- [ ] **Step 3: Update the handler import and registration logic**

In `skills/signal-send/handler.ts`, change the import (line 5):

```typescript
import { registerOutboundContext } from '../../src/dispatch/context-bridge-parse.js';
```

(Remove the old imports `parseContextBridge, registerContextBridge`.)

Replace the group-path registration block (after successful `ctx.outboundGateway.send` in the group section):

```typescript
        // Register outbound context entry (best-effort, always fires).
        await registerOutboundContext(ctx.outboundContext, contextBridgeRaw, {
          channelId: 'signal',
          content: message,
          agentId: ctx.agentId ?? 'coordinator',
          log: ctx.log,
        });
```

Replace the 1:1 path registration block (after successful send):

```typescript
      // Register outbound context entry (best-effort, always fires).
      await registerOutboundContext(ctx.outboundContext, contextBridgeRaw, {
        channelId: 'signal',
        content: message,
        agentId: ctx.agentId ?? 'coordinator',
        log: ctx.log,
      });
```

- [ ] **Step 4: Update the existing "registers a context bridge entry" test mock to include TTL properties**

In `skills/signal-send/handler.test.ts`, find the mock at line 205 and update:

```typescript
      (ctx as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
      };
```

Update the expected call assertion to include `expiresInHours: 48` (from the `expires_in_hours` in the bridge JSON — this was already there) — verify it still passes.

Also update the "does not register when send fails" test mock at line 252 similarly:

```typescript
      (ctx as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
      };
```

- [ ] **Step 5: Run all signal-send tests**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run skills/signal-send/handler.test.ts --reporter=verbose 2>&1 | tail -30`

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister add skills/signal-send/handler.ts skills/signal-send/handler.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister commit -m "feat(signal-send): unconditional outbound context registration"
```

---

### Task 4: Update `email-send` handler to use unconditional registration

**Files:**
- Modify: `skills/email-send/handler.ts`
- Modify: `skills/email-send/handler.test.ts`

- [ ] **Step 1: Read the current email-send handler to identify the registration block**

Read: `skills/email-send/handler.ts` — find the `parseContextBridge` / `registerContextBridge` import and call site.

- [ ] **Step 2: Update the test — "absent context_bridge" now registers**

In `skills/email-send/handler.test.ts`, find the test that asserts register is NOT called when `context_bridge` is absent. Replace with:

```typescript
    it('registers a minimal entry when context_bridge is absent', async () => {
      // ... setup ctx with successful send, outboundContext mock including TTL props
      // Assert: mockRegister called with { channelId: 'email', agentId: 'coordinator', content: <message>, expiresInHours: 6 }
    });
```

(Use the same pattern as Task 3 Step 1, adapted for `channelId: 'email'`.)

- [ ] **Step 3: Run tests to verify it fails**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run skills/email-send/handler.test.ts --reporter=verbose 2>&1 | tail -20`

- [ ] **Step 4: Update the handler**

Change import to `registerOutboundContext`, remove `parseContextBridge`/`registerContextBridge`. Replace the conditional registration with:

```typescript
      await registerOutboundContext(ctx.outboundContext, contextBridgeRaw, {
        channelId: 'email',
        content: message,
        agentId: ctx.agentId ?? 'coordinator',
        log: ctx.log,
      });
```

Update all outboundContext mocks in existing tests to include `defaultExpiryHours: 6, explicitExpiryHours: 24`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run skills/email-send/handler.test.ts --reporter=verbose 2>&1 | tail -20`

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister add skills/email-send/handler.ts skills/email-send/handler.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister commit -m "feat(email-send): unconditional outbound context registration"
```

---

### Task 5: Update `email-reply` handler to use unconditional registration

**Files:**
- Modify: `skills/email-reply/handler.ts`
- Modify: `skills/email-reply/handler.test.ts`

- [ ] **Step 1: Read the current email-reply handler**

Read: `skills/email-reply/handler.ts` — find the registration block.

- [ ] **Step 2: Update the test — same pattern as Tasks 3 and 4**

- [ ] **Step 3: Run tests to verify it fails**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run skills/email-reply/handler.test.ts --reporter=verbose 2>&1 | tail -20`

- [ ] **Step 4: Update the handler — same pattern**

Change import, replace conditional with `registerOutboundContext` call using `channelId: 'email'`. Update mocks.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run skills/email-reply/handler.test.ts --reporter=verbose 2>&1 | tail -20`

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister add skills/email-reply/handler.ts skills/email-reply/handler.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister commit -m "feat(email-reply): unconditional outbound context registration"
```

---

### Task 6: Add config keys — YAML interface, JSON Schema, defaults, validation

**Files:**
- Modify: `src/config.ts:249` (before closing brace of `YamlConfig`)
- Modify: `schemas/default-config.schema.json:275` (before `definitions`)
- Modify: `config/default.yaml` (after `skillOutput` block)
- Modify: `src/config.ts:~420` (validation section)

- [ ] **Step 1: Add `contextBridge` to the `YamlConfig` interface**

In `src/config.ts`, before the closing `}` of `YamlConfig` (line 251), add:

```typescript
  contextBridge?: {
    /** TTL in hours for auto-registered entries (no explicit context_bridge param). Default: 6. */
    defaultExpiryHours?: number;
    /** TTL in hours for entries with explicit context_bridge metadata. Default: 24. */
    explicitExpiryHours?: number;
  };
```

- [ ] **Step 2: Add validation in `loadYamlConfig`**

In `src/config.ts`, after the existing `workingMemory` validation block (around line 440), add:

```typescript
  if (config.contextBridge !== undefined) {
    const { defaultExpiryHours, explicitExpiryHours } = config.contextBridge;
    if (defaultExpiryHours !== undefined && (!Number.isInteger(defaultExpiryHours) || defaultExpiryHours < 1)) {
      throw new Error(`contextBridge.defaultExpiryHours must be a positive integer, got: ${defaultExpiryHours}`);
    }
    if (explicitExpiryHours !== undefined && (!Number.isInteger(explicitExpiryHours) || explicitExpiryHours < 1)) {
      throw new Error(`contextBridge.explicitExpiryHours must be a positive integer, got: ${explicitExpiryHours}`);
    }
  }
```

- [ ] **Step 3: Add to JSON Schema**

In `schemas/default-config.schema.json`, before the `"definitions"` key (line 277), add a new property inside `"properties"`:

```json
    "contextBridge": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "defaultExpiryHours": { "type": "integer", "minimum": 1 },
        "explicitExpiryHours": { "type": "integer", "minimum": 1 }
      }
    },
```

- [ ] **Step 4: Add defaults to `config/default.yaml`**

After the `skillOutput` block (line 111), add:

```yaml

# Context bridge TTL configuration.
# Controls how long outbound context entries remain active before automatic expiry.
# Auto-registered entries (when the caller doesn't pass explicit context_bridge metadata)
# use defaultExpiryHours. Entries with explicit delegation hints use explicitExpiryHours.
# A caller-specified expires_in_hours in the context_bridge JSON always overrides these.
contextBridge:
  defaultExpiryHours: 6      # auto-registered entries (proactive sends without metadata)
  explicitExpiryHours: 24    # entries with explicit context_bridge JSON
```

- [ ] **Step 5: Run config validation tests (if they exist)**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run src/config --reporter=verbose 2>&1 | tail -20`

If no config test file exists, run `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run --reporter=verbose 2>&1 | tail -40` to confirm nothing broke.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister add src/config.ts schemas/default-config.schema.json config/default.yaml
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister commit -m "feat: add contextBridge TTL config keys with validation"
```

---

### Task 7: Wire config into `OutboundContextService` at bootstrap

**Files:**
- Modify: `src/index.ts:1065-1066`

- [ ] **Step 1: Update bootstrap to pass config**

In `src/index.ts`, find line 1065:

```typescript
  const outboundContextService = pool
    ? new OutboundContextService(pool, logger)
```

Replace with:

```typescript
  const outboundContextService = pool
    ? new OutboundContextService(pool, logger, {
        defaultExpiryHours: yamlConfig.contextBridge?.defaultExpiryHours,
        explicitExpiryHours: yamlConfig.contextBridge?.explicitExpiryHours,
      })
```

- [ ] **Step 2: Run type check**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister tsc --noEmit 2>&1 | tail -20`

Expected: Zero errors.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister add src/index.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister commit -m "feat: wire contextBridge config into OutboundContextService at bootstrap"
```

---

### Task 8: Update `docs/dev/configuration.md`

**Files:**
- Modify: `docs/dev/configuration.md` (after the `skillOutput` section, ~line 101)

- [ ] **Step 1: Add documentation section**

After the `skillOutput` section (after line 101 "Raise the limit if skills are cutting off important results..."), add:

```markdown

---

### `contextBridge`

Controls TTL (time-to-live) for outbound context entries — the records that let the coordinator link incoming replies to messages it previously sent.

```yaml
contextBridge:
  defaultExpiryHours: 6     # TTL for auto-registered entries (no explicit context_bridge param). Default: 6.
  explicitExpiryHours: 24   # TTL for entries with explicit context_bridge delegation metadata. Default: 24.
```

Every outbound message (Signal, email) automatically registers a context entry so that if the recipient replies, the coordinator knows what they're replying to. Entries registered without explicit `context_bridge` metadata get the shorter `defaultExpiryHours` TTL. Entries with delegation hints and expected-reply metadata get the longer `explicitExpiryHours` TTL.

When a caller passes `expires_in_hours` inside the `context_bridge` JSON param, it overrides `explicitExpiryHours` for that individual entry.

Expired entries are cleaned up automatically by the background scheduler. The coordinator can also release entries manually via the `context-bridge-release` skill.

**Tuning guidance:**
- Raise `defaultExpiryHours` if users commonly reply to proactive notifications after more than 6 hours.
- Lower it if the `[ACTIVE OUTBOUND CONTEXT]` block is accumulating too many stale entries and causing noise.
- `explicitExpiryHours` should be higher because explicit entries carry delegation metadata that's expensive to re-derive.
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister add docs/dev/configuration.md
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister commit -m "docs: document contextBridge TTL config keys"
```

---

### Task 9: Update coordinator prompt

**Files:**
- Modify: `agents/coordinator.yaml:209` (after the context-bridge-release line)

- [ ] **Step 1: Add the "Enriching outbound context" subsection**

In `agents/coordinator.yaml`, after line 208 ("context entry using context-bridge-release (pass the entry_id shown in the block)"), add:

```yaml

  ### Enriching outbound context
  When you call signal-send, email-send, or email-reply and you know which
  specialist should handle any reply, pass the context_bridge parameter:

    context_bridge: {"agent_id": "coordinator", "delegation_hint": "calendar-specialist", "expected_reply": "confirmation or reschedule request"}

  This is optional — every outbound message is automatically tracked. But passing
  context_bridge adds delegation hints that help you route replies faster without
  needing to re-derive context.
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister add agents/coordinator.yaml
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister commit -m "feat(coordinator): add guidance for enriching outbound context with delegation hints"
```

---

### Task 10: Full test suite and type check

**Files:** None modified — verification only.

- [ ] **Step 1: Run TypeScript type check**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister tsc --noEmit 2>&1 | tail -30`

Expected: Zero errors.

- [ ] **Step 2: Run the full test suite**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run --reporter=verbose 2>&1 | tail -60`

Expected: All tests pass (the 3 pre-existing autonomy integration test failures mentioned in PR #678's test plan are acceptable).

- [ ] **Step 3: Specifically verify existing context bridging tests still pass**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister vitest run tests/unit/dispatch/dispatcher-context-bridging.test.ts --reporter=verbose 2>&1 | tail -30`

Expected: All existing context bridging tests pass unchanged.

- [ ] **Step 4: If any failures, fix and commit fixes**

---

### Task 11: Create PR

- [ ] **Step 1: Push branch**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-bridge-autoregister push -u origin fix/context-bridge-autoregister
```

- [ ] **Step 2: Run pre-PR review subagents** (per CLAUDE.md auto-review rule)

Launch `pr-review-toolkit:code-reviewer` and `pr-review-toolkit:silent-failure-hunter` in parallel on all changes vs main.

- [ ] **Step 3: Address findings and commit if needed**

- [ ] **Step 4: Create PR**

```bash
gh pr create --repo josephfung/curia --base main --head fix/context-bridge-autoregister --title "fix: unconditional outbound context registration (closes #609)" --body "$(cat <<'EOF'
## Summary

- Every successful outbound send now registers a context entry (auto or explicit)
- Removes the opt-in gap where proactive sends had no context tracking
- Adds configurable TTLs: `contextBridge.defaultExpiryHours` (6h) and `contextBridge.explicitExpiryHours` (24h)
- Coordinator prompt updated with guidance on enriching entries with delegation hints

## Test plan

- [ ] All new unit tests pass (registerOutboundContext utility, send skill handlers)
- [ ] Existing 55 context bridging tests pass unchanged
- [ ] `tsc --noEmit` — zero type errors
- [ ] Config validation rejects invalid values
- [ ] Full test suite passes (pre-existing autonomy integration failures acceptable)

Closes #609
EOF
)"
```

- [ ] **Step 5: Confirm CI started**

```bash
gh run list --repo josephfung/curia --branch fix/context-bridge-autoregister --limit 1
```

Report PR URL and CI status.
