# Caller Verification for Elevated Skills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce programmatic caller verification on `sensitivity: "elevated"` skills so only the CEO (or CLI) can trigger permission-modifying actions, and record the real caller identity in audit fields.

**Architecture:** Add a `CallerContext` type carrying `contactId`, `role`, and `channel`. The agent runtime extracts it from the task event's `senderContext` and passes it to `ExecutionLayer.invoke()`. The execution layer gates elevated skills (fail-closed) before building the skill context. Skills receive `caller` on `SkillContext` for audit fields.

**Tech Stack:** TypeScript/ESM, Vitest, pino

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/skills/types.ts` | Modify | Add `CallerContext` interface, add `caller?` to `SkillContext` |
| `src/skills/execution.ts` | Modify | Add `caller?` param to `invoke()`, enforce elevated-skill gate |
| `src/agents/runtime.ts` | Modify | Extract `CallerContext` from `taskEvent`, pass to `invoke()` |
| `src/contacts/contact-service.ts` | Modify | `grantPermission()` accepts `grantedBy` param |
| `skills/contact-grant-permission/handler.ts` | Modify | Pass `ctx.caller!.contactId` as `grantedBy` |
| `skills/contact-set-role/skill.json` | Modify | Change `sensitivity` to `"elevated"` |
| `tests/unit/skills/execution.test.ts` | Modify | Add gate logic tests |
| `tests/unit/contacts/contact-service.test.ts` | Modify | Update `grantPermission` calls for new signature |

---

### Task 1: Add `CallerContext` type and extend `SkillContext`

**Files:**
- Modify: `src/skills/types.ts`

- [ ] **Step 1: Add `CallerContext` interface**

In `src/skills/types.ts`, add the following interface after the `SkillManifest` interface (before `SkillContext`):

```typescript
/**
 * Minimal caller identity passed through the execution layer.
 * Used for elevated-skill gate checks and audit fields (e.g., grantedBy).
 * Intentionally lean — no KG facts, no authorization result.
 */
export interface CallerContext {
  /** 'primary-user' for CLI, actual contact ID otherwise */
  contactId: string;
  /** 'ceo', 'cfo', null, etc. */
  role: string | null;
  /** Originating channel: 'cli', 'email', 'signal', etc. */
  channel: string;
}
```

- [ ] **Step 2: Add `caller?` field to `SkillContext`**

In the `SkillContext` interface, add after the `heldMessages` field:

```typescript
  /** Caller identity — populated from the task event's sender context.
   *  Guaranteed to be defined for elevated skills (execution layer rejects without it).
   *  Available but optional for normal skills. */
  caller?: CallerContext;
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no consumers of the new fields yet)

- [ ] **Step 4: Commit**

```bash
git add src/skills/types.ts
git commit -m "feat: add CallerContext type and caller field to SkillContext"
```

---

### Task 2: Add elevated-skill gate to the execution layer

**Files:**
- Modify: `src/skills/execution.ts`
- Modify: `tests/unit/skills/execution.test.ts`

- [ ] **Step 1: Write failing tests for the elevated-skill gate**

Add the following tests to `tests/unit/skills/execution.test.ts`. These go inside the existing `describe('ExecutionLayer', ...)` block, after the last existing test:

```typescript
  describe('elevated skill caller verification', () => {
    it('allows elevated skill when caller has ceo role', async () => {
      const handler: SkillHandler = {
        execute: async () => ({ success: true, data: 'ok' }),
      };
      registry.register(makeManifest({ name: 'elevated-skill', sensitivity: 'elevated' }), handler);

      const result = await execution.invoke('elevated-skill', {}, {
        contactId: 'primary-user',
        role: 'ceo',
        channel: 'email',
      });
      expect(result.success).toBe(true);
    });

    it('allows elevated skill when caller channel is cli', async () => {
      const handler: SkillHandler = {
        execute: async () => ({ success: true, data: 'ok' }),
      };
      registry.register(makeManifest({ name: 'elevated-skill', sensitivity: 'elevated' }), handler);

      const result = await execution.invoke('elevated-skill', {}, {
        contactId: 'primary-user',
        role: 'ceo',
        channel: 'cli',
      });
      expect(result.success).toBe(true);
    });

    it('rejects elevated skill when caller is not ceo and not cli', async () => {
      const handler: SkillHandler = {
        execute: async () => ({ success: true, data: 'should not reach' }),
      };
      registry.register(makeManifest({ name: 'elevated-skill', sensitivity: 'elevated' }), handler);

      const result = await execution.invoke('elevated-skill', {}, {
        contactId: 'contact-123',
        role: 'cfo',
        channel: 'email',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('elevated privileges');
        expect(result.error).toContain('cfo');
        expect(result.error).toContain('email');
      }
    });

    it('rejects elevated skill when no caller context (fail-closed)', async () => {
      const handler: SkillHandler = {
        execute: async () => ({ success: true, data: 'should not reach' }),
      };
      registry.register(makeManifest({ name: 'elevated-skill', sensitivity: 'elevated' }), handler);

      const result = await execution.invoke('elevated-skill', {});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('elevated privileges');
        expect(result.error).toContain('no caller context');
      }
    });

    it('allows normal skill without caller context', async () => {
      const handler: SkillHandler = {
        execute: async () => ({ success: true, data: 'ok' }),
      };
      registry.register(makeManifest({ name: 'normal-skill', sensitivity: 'normal' }), handler);

      const result = await execution.invoke('normal-skill', {});
      expect(result.success).toBe(true);
    });

    it('passes caller through to SkillContext', async () => {
      let receivedCaller: unknown;
      const handler: SkillHandler = {
        execute: async (ctx: SkillContext) => {
          receivedCaller = ctx.caller;
          return { success: true, data: 'ok' };
        },
      };
      registry.register(makeManifest({ name: 'elevated-skill', sensitivity: 'elevated' }), handler);

      const caller = { contactId: 'primary-user', role: 'ceo' as const, channel: 'cli' };
      await execution.invoke('elevated-skill', {}, caller);
      expect(receivedCaller).toEqual(caller);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/skills/execution.test.ts`
Expected: FAIL — `invoke()` doesn't accept a third argument yet

- [ ] **Step 3: Implement the elevated-skill gate in `ExecutionLayer.invoke()`**

In `src/skills/execution.ts`, add the import for `CallerContext`:

Change the existing import line:
```typescript
import type { SkillResult, SkillContext } from './types.js';
```
to:
```typescript
import type { SkillResult, SkillContext, CallerContext } from './types.js';
```

Then update the `invoke` method signature from:
```typescript
  async invoke(
    skillName: string,
    input: Record<string, unknown>,
  ): Promise<SkillResult> {
```
to:
```typescript
  async invoke(
    skillName: string,
    input: Record<string, unknown>,
    caller?: CallerContext,
  ): Promise<SkillResult> {
```

Add the elevated-skill gate check immediately after `const { manifest, handler } = skill;` and before `const skillLogger = ...`:

```typescript
    // Elevated-skill gate: enforce caller verification before building context.
    // Fail-closed — if caller context is missing, elevated skills are blocked.
    if (manifest.sensitivity === 'elevated') {
      if (!caller) {
        return {
          success: false,
          error: `Skill '${skillName}' requires elevated privileges — no caller context provided (fail-closed)`,
        };
      }
      if (caller.role !== 'ceo' && caller.channel !== 'cli') {
        return {
          success: false,
          error: `Skill '${skillName}' requires elevated privileges — caller role '${caller.role}' on channel '${caller.channel}' is not authorized`,
        };
      }
    }
```

Then add `caller` to the `SkillContext` object. After the line `log: skillLogger,` in the ctx construction, add:

```typescript
      caller,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/skills/execution.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/skills/execution.ts tests/unit/skills/execution.test.ts
git commit -m "feat: add elevated-skill caller verification gate to execution layer"
```

---

### Task 3: Wire caller context from agent runtime to execution layer

**Files:**
- Modify: `src/agents/runtime.ts`

- [ ] **Step 1: Add CallerContext import**

At the top of `src/agents/runtime.ts`, add to the imports:

```typescript
import type { CallerContext } from '../skills/types.js';
```

- [ ] **Step 2: Extract caller context and pass to `invoke()`**

In the `processTask` method, find the line (around line 236):
```typescript
        const result = await executionLayer.invoke(toolCall.name, toolCall.input);
```

Add the caller extraction immediately before the `for (const toolCall of response.toolCalls)` loop (around line 221, before `const toolResultBlocks`):

```typescript
      // Extract caller context from the task event's sender context.
      // Unresolved senders produce undefined, which triggers the execution layer's
      // fail-closed gate on elevated skills — unknown senders can't modify permissions.
      const senderCtx = taskEvent.payload.senderContext;
      const caller: CallerContext | undefined = (senderCtx && senderCtx.resolved)
        ? { contactId: senderCtx.contactId, role: senderCtx.role, channel: taskEvent.payload.channelId }
        : undefined;
```

Then update the `invoke` call to pass `caller`:
```typescript
        const result = await executionLayer.invoke(toolCall.name, toolCall.input, caller);
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (existing tests still work — `caller` is optional)

- [ ] **Step 5: Commit**

```bash
git add src/agents/runtime.ts
git commit -m "feat: wire CallerContext from agent runtime to execution layer"
```

---

### Task 4: Update `ContactService.grantPermission()` to accept `grantedBy`

**Files:**
- Modify: `src/contacts/contact-service.ts`
- Modify: `tests/unit/contacts/contact-service.test.ts`

- [ ] **Step 1: Write a failing test for the new `grantedBy` parameter**

In `tests/unit/contacts/contact-service.test.ts`, the existing test `'grants a permission override'` calls `grantPermission` with 3 args. We need to update the existing calls to pass 4 args and add a test that verifies the `grantedBy` value is stored. However, `getAuthOverrides` returns `{ permission, granted }` — not `grantedBy`. So we test indirectly: the test verifies the method accepts the param and doesn't throw.

Update the existing `'grants a permission override'` test to pass a `grantedBy` value:

```typescript
    it('grants a permission override', async () => {
      const contact = await service.createContact({ displayName: 'Dave', source: 'test' });
      await service.grantPermission(contact.id, 'schedule_meetings', true, 'primary-user');

      const overrides = await service.getAuthOverrides(contact.id);
      expect(overrides).toHaveLength(1);
      expect(overrides[0]).toEqual({ permission: 'schedule_meetings', granted: true });
    });
```

Update the existing `'upserts an override (grant then change to deny)'` test:

```typescript
    it('upserts an override (grant then change to deny)', async () => {
      const contact = await service.createContact({ displayName: 'Frank', source: 'test' });
      await service.grantPermission(contact.id, 'send_on_behalf', true, 'primary-user');
      await service.grantPermission(contact.id, 'send_on_behalf', false, 'primary-user');

      const overrides = await service.getAuthOverrides(contact.id);
      expect(overrides).toHaveLength(1);
      expect(overrides[0]).toEqual({ permission: 'send_on_behalf', granted: false });
    });
```

Update the existing `'grantPermission throws for non-existent contact'` test:

```typescript
    it('grantPermission throws for non-existent contact', async () => {
      await expect(service.grantPermission('non-existent', 'foo', true, 'primary-user')).rejects.toThrow('Contact not found');
    });
```

Also update the `'revokes a permission override'` test which calls `grantPermission`:

```typescript
    it('revokes a permission override', async () => {
      const contact = await service.createContact({ displayName: 'Eve', source: 'test' });
      await service.grantPermission(contact.id, 'see_personal_calendar', true, 'primary-user');
      await service.revokePermission(contact.id, 'see_personal_calendar');

      const overrides = await service.getAuthOverrides(contact.id);
      expect(overrides).toHaveLength(0);
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/contacts/contact-service.test.ts`
Expected: FAIL — `grantPermission` doesn't accept a 4th argument (TypeScript will accept it at runtime but it'll be ignored; the real failure is the test expectation won't change yet. Actually since the current signature is 3 params, adding a 4th is fine in JS but won't be used. The test should still pass at this point — the real verification is after the signature change.)

Note: These tests may still pass because JavaScript ignores extra arguments. The real verification is in Step 4 after the implementation change.

- [ ] **Step 3: Update `grantPermission` signature**

In `src/contacts/contact-service.ts`, change the `grantPermission` method (around line 271) from:

```typescript
  async grantPermission(contactId: string, permission: string, granted: boolean): Promise<void> {
```
to:
```typescript
  async grantPermission(contactId: string, permission: string, granted: boolean, grantedBy: string): Promise<void> {
```

And change the hardcoded `grantedBy: 'ceo'` (line 282) to use the parameter:

```typescript
      grantedBy,
```

So the full override construction becomes:
```typescript
    const override: AuthOverride = {
      id: randomUUID(),
      contactId,
      permission,
      granted,
      grantedBy,
      createdAt: new Date(),
      revokedAt: null,
    };
```

- [ ] **Step 4: Run typecheck to find any other callers**

Run: `npx tsc --noEmit`
Expected: This may surface errors in the `contact-grant-permission` handler (which calls `grantPermission` with 3 args). That's expected — we fix it in Task 5.

- [ ] **Step 5: Run contact-service tests to verify they pass**

Run: `npx vitest run tests/unit/contacts/contact-service.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/contacts/contact-service.ts tests/unit/contacts/contact-service.test.ts
git commit -m "feat: accept grantedBy param in ContactService.grantPermission()"
```

---

### Task 5: Update `contact-grant-permission` handler to use caller context

**Files:**
- Modify: `skills/contact-grant-permission/handler.ts`

- [ ] **Step 1: Update handler to pass `ctx.caller!.contactId` as `grantedBy`**

In `skills/contact-grant-permission/handler.ts`, change the `grantPermission` call (line 34) from:

```typescript
      await ctx.contactService.grantPermission(contact_id, permission, granted);
```
to:
```typescript
      // caller is guaranteed defined for elevated skills — the execution layer
      // rejects elevated invocations without caller context (fail-closed gate).
      await ctx.contactService.grantPermission(contact_id, permission, granted, ctx.caller!.contactId);
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (the type error from Task 4 is now resolved)

- [ ] **Step 3: Commit**

```bash
git add skills/contact-grant-permission/handler.ts
git commit -m "feat: use real caller identity for grantedBy instead of hardcoded 'ceo'"
```

---

### Task 6: Elevate `contact-set-role` sensitivity

**Files:**
- Modify: `skills/contact-set-role/skill.json`

- [ ] **Step 1: Change sensitivity to "elevated"**

In `skills/contact-set-role/skill.json`, change:

```json
  "sensitivity": "normal",
```
to:
```json
  "sensitivity": "elevated",
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add skills/contact-set-role/skill.json
git commit -m "fix: elevate contact-set-role sensitivity to 'elevated'"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (zero errors)

- [ ] **Step 3: Review all changes**

Run: `git diff main --stat` and `git log --oneline main..HEAD`

Verify:
- 6 commits on the branch (1 spec + 5 implementation)
- Files changed match the file map in the plan
- No unintended changes
