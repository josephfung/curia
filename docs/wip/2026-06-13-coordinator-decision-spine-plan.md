# Coordinator Decision-Spine Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-derive the coordinator system prompt around an explicit three-way routing decision and convert the `${...}` runtime blocks to always-injected positions, fixing systemic under-delegation of transfer-ownership replies (#957).

**Architecture:** The coordinator prompt body is reorganized into a 5-part taxonomy (Who I am / The routing decision / What I do directly / What I proactively surface / Reference). The runtime stops doing in-place `${...}` placeholder replacement and instead prepends a fixed preamble (identity, security) and appends fixed blocks (available specialists, contact ID). The vestigial executive-voice injection is removed entirely. Specialist agents are untouched.

**Tech Stack:** TypeScript (ESM, Node 22+), Vitest, YAML agent configs. All commands run from the worktree `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine`.

**Reference:** Design spec at `docs/wip/2026-06-13-coordinator-decision-spine-design.md` — the porting checklist table and "Intended behavior changes" section are authoritative for Task 5.

**Conventions for every command below:**
- Run tests with: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine test <args>`
- Run typecheck with: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine run typecheck`
- Commit with `git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine ...`
- No `Co-Authored-By` / no Claude attribution in commits.

---

## File Structure

Files touched, and the responsibility of each change:

- **`agents/coordinator.yaml`** — remove all 5 `${...}` placeholders; restructure the `system_prompt` body into the 5-part taxonomy; add the transfer-ownership reply rule; bump `version` to `0.7.0`.
- **`src/agents/runtime.ts`** — replace in-place identity/security substitution with a prepended preamble; append `## Available Specialists` and a `Contact ID:` line; remove the executive-voice injection block, the `executiveProfileService`/`executiveDisplayName` config fields, and the `compileWritingVoiceBlock` import; add `availableSpecialists` and `agentContactId` config fields.
- **`src/agents/loader.ts`** — remove the `${executive_voice_block}` branch and the `executiveVoiceBlock` context field from `interpolateRuntimeContext`; update its JSDoc. Specialist branches (`${available_specialists}`, `${agent_contact_id}`, `${principal_contact_id}`) stay.
- **`src/index.ts`** — for the coordinator's `AgentRuntime`, pass `availableSpecialists` (from `agentRegistry.specialistSummary()`) and `agentContactId`; stop passing `executiveProfileService`/`executiveDisplayName`; delete the missing-`${security_context_block}` failsafe warning (~L942-952).
- **`tests/unit/agents/runtime.test.ts`** — rewrite security tests for prepend semantics; add preamble-ordering, available-specialists, and contact-ID tests; remove the two executive-voice tests and the now-unused `ExecutiveProfile` import.
- **`tests/unit/agents/loader.test.ts`** — flip the two `${office_identity_block}`-present assertions; add a guard test asserting the coordinator YAML has no `${...}` placeholders.
- **`CHANGELOG.md`** — `[Unreleased]` Changed + Removed entries.

---

## Task 1: Prepend identity + security as a fixed preamble; remove the failsafe

**Files:**
- Modify: `src/agents/runtime.ts` (the office-identity block ~218-235 and security block ~237-257)
- Modify: `src/index.ts` (delete failsafe warning ~942-952)
- Modify: `agents/coordinator.yaml` (remove `${office_identity_block}` L10 and `${security_context_block}` L12)
- Test: `tests/unit/agents/runtime.test.ts` (security tests ~619-705)

- [ ] **Step 1: Rewrite the security tests for prepend semantics**

In `tests/unit/agents/runtime.test.ts`, replace the three existing security tests (the `replaces ${security_context_block} placeholder...`, `appends securityContextBlock unconditionally...`, and `does not modify the prompt when securityContextBlock is not provided` tests, ~L619-705) with these:

```typescript
  it('prepends securityContextBlock above the body when set', async () => {
    const provider = createMockProvider('OK');
    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'Body text.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger: createLogger('error'),
      securityContextBlock: '## Security\nPolicy here.',
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-sec-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-sec-1',
    });
    await bus.publish('dispatch', task);

    const systemMsg = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0].messages[0]!.content as string;
    // Security block sits at the very top, immediately above the body.
    expect(systemMsg.startsWith('## Security\nPolicy here.\n\nBody text.')).toBe(true);
    // Block appears exactly once (no duplicate append).
    expect(systemMsg.indexOf('## Security')).toBe(systemMsg.lastIndexOf('## Security'));
  });

  it('does not inject a security block when securityContextBlock is omitted', async () => {
    const provider = createMockProvider('OK');
    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'Only this text.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger: createLogger('error'),
      // securityContextBlock intentionally omitted
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-sec-3',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-sec-3',
    });
    await bus.publish('dispatch', task);

    const systemMsg = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0].messages[0]!.content as string;
    expect(systemMsg).not.toContain('## Security');
  });
```

- [ ] **Step 2: Run the new security tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine test runtime.test.ts -t "prepends securityContextBlock"`
Expected: FAIL — current code replaces in-place / appends, so the block is not at the top.

- [ ] **Step 3: Replace the in-place identity + security substitution with a prepended preamble**

In `src/agents/runtime.ts`, find the block that starts with the `// Replace the ${office_identity_block} placeholder` comment (~L218) and ends at the close of the security `if (this.config.securityContextBlock) { ... }` block (~L257). Replace that entire span with:

```typescript
    // Build the fixed preamble — constraints first, most salient. Identity then
    // security are PREPENDED to the body (not substituted in-place), so the YAML
    // carries no ${...} placeholders. Both are coordinator-only: the services /
    // block are passed to AgentRuntime only for the coordinator (see src/index.ts).
    // Per-task (not startup) so identity/security hot-reloads take effect next turn.
    let effectiveSystemPrompt = systemPrompt;
    const preambleParts: string[] = [];
    if (officeIdentityService) {
      try {
        preambleParts.push(officeIdentityService.compileSystemPromptBlock());
      } catch (err) {
        // A compile failure must not abort the task. Log at error (operator signal)
        // and proceed without the identity block rather than emitting a literal
        // placeholder or a structurally broken block.
        logger.error({ err, agentId }, 'Failed to compile identity block — identity preamble omitted this turn');
      }
    }
    // Security context is a platform guarantee, not opt-in text. When provided it is
    // always prepended directly after identity. No try-catch: string concatenation
    // cannot throw. (Removed the old missing-placeholder append failsafe — the block
    // now has a single, fixed home.)
    if (this.config.securityContextBlock) {
      preambleParts.push(this.config.securityContextBlock);
    }
    if (preambleParts.length > 0) {
      effectiveSystemPrompt = preambleParts.join('\n\n') + '\n\n' + effectiveSystemPrompt;
    }
```

Note: this removes the old `let effectiveSystemPrompt = systemPrompt;` declaration that preceded the identity block — the new code declares it. Ensure there is no duplicate `let effectiveSystemPrompt` remaining below.

- [ ] **Step 4: Run the security tests to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine test runtime.test.ts -t "security"`
Expected: PASS for both new tests.

- [ ] **Step 5: Add a preamble-ordering test (identity before security, both before body)**

Add this test in `tests/unit/agents/runtime.test.ts` next to the security tests. It uses a minimal fake `officeIdentityService` exposing only `compileSystemPromptBlock`:

```typescript
  it('prepends identity above security, both above the body', async () => {
    const provider = createMockProvider('OK');
    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'Body text.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger: createLogger('error'),
      officeIdentityService: {
        compileSystemPromptBlock: () => '## Identity\nWho you are.',
      } as unknown as import('../../../src/identity/service.js').OfficeIdentityService,
      securityContextBlock: '## Security\nPolicy here.',
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-preamble-order',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-preamble-order',
    });
    await bus.publish('dispatch', task);

    const systemMsg = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0].messages[0]!.content as string;
    const idPos = systemMsg.indexOf('## Identity');
    const secPos = systemMsg.indexOf('## Security');
    const bodyPos = systemMsg.indexOf('Body text.');
    expect(idPos).toBeGreaterThan(-1);
    expect(idPos).toBeLessThan(secPos);
    expect(secPos).toBeLessThan(bodyPos);
  });
```

- [ ] **Step 6: Run the ordering test**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine test runtime.test.ts -t "prepends identity above security"`
Expected: PASS.

- [ ] **Step 7: Delete the failsafe warning in `src/index.ts`**

Remove the entire block at ~L942-952 (the comment beginning `// Warn if the coordinator system prompt is missing the ${security_context_block} placeholder.` through the closing `}` of the `if (coordinatorConfig && !coordinatorConfig.system_prompt.includes('${security_context_block}')) { ... }`). Keep the `const coordinatorConfig = ...` line at L940 — it is used later in the file (verify with a search for `coordinatorConfig` before deleting it; if it has no other use after your edits, also remove that line).

- [ ] **Step 8: Surgically remove the two placeholders from `agents/coordinator.yaml`**

Delete L10 (`${office_identity_block}`) and L12 (`${security_context_block}`) and the blank line between them, so the `system_prompt` now begins with the `## Date & Time` section. (The full prose restructure happens in Task 5 — this is the minimal change to keep this commit coherent.)

- [ ] **Step 9: Run the full runtime test file + typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine test runtime.test.ts`
Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine run typecheck`
Expected: all runtime tests PASS; typecheck clean.

- [ ] **Step 10: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine add src/agents/runtime.ts src/index.ts agents/coordinator.yaml tests/unit/agents/runtime.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine commit -m "refactor: prepend identity+security preamble, drop placeholder failsafe (#957)"
```

---

## Task 2: Append the `## Available Specialists` block; thread `availableSpecialists`

**Files:**
- Modify: `src/agents/runtime.ts` (`AgentConfig` interface ~L27-118; injection in `processTask` after the preamble)
- Modify: `src/index.ts` (coordinator `AgentRuntime` construction ~L1700-1765)
- Modify: `agents/coordinator.yaml` (remove `${available_specialists}` L440)
- Test: `tests/unit/agents/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/agents/runtime.test.ts`:

```typescript
  it('appends ## Available Specialists when availableSpecialists is provided', async () => {
    const provider = createMockProvider('OK');
    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'Body text.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger: createLogger('error'),
      availableSpecialists: '- calendar-specialist: schedules meetings\n- contacts: resolves people',
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-specialists-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-specialists-1',
    });
    await bus.publish('dispatch', task);

    const systemMsg = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0].messages[0]!.content as string;
    expect(systemMsg).toContain('## Available Specialists');
    expect(systemMsg).toContain('- calendar-specialist: schedules meetings');
  });

  it('does not append ## Available Specialists for a non-coordinator agent (no availableSpecialists)', async () => {
    const provider = createMockProvider('OK');
    const runtime = new AgentRuntime({
      agentId: 'calendar',
      systemPrompt: 'Specialist body.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger: createLogger('error'),
      // availableSpecialists intentionally omitted
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'calendar',
      conversationId: 'conv-specialists-2',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-specialists-2',
    });
    await bus.publish('dispatch', task);

    const systemMsg = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0].messages[0]!.content as string;
    expect(systemMsg).not.toContain('## Available Specialists');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine test runtime.test.ts -t "Available Specialists"`
Expected: FAIL — `availableSpecialists` is not yet a config field and no block is injected.

- [ ] **Step 3: Add the `availableSpecialists` config field**

In `src/agents/runtime.ts`, add to the `AgentConfig` interface (near the other injected-block fields, e.g. after `principalIdentities` ~L82):

```typescript
  /** The specialist roster string (from AgentRegistry.specialistSummary()). When provided,
   *  a "## Available Specialists" block is appended to the system prompt. Passed only for
   *  the coordinator and inject_specialists agents — see src/index.ts. Specialists that use
   *  the ${available_specialists} bootstrap placeholder are unaffected. */
  availableSpecialists?: string;
```

- [ ] **Step 4: Append the block in `processTask`**

In `src/agents/runtime.ts`, immediately after the preamble assembly added in Task 1 (after the `if (preambleParts.length > 0) { ... }` block), insert:

```typescript
    // Append the specialist roster as a fixed appendix block. Coordinator-only in
    // practice (passed only for the coordinator in src/index.ts); gated on presence
    // so specialists that don't route work never see it.
    if (this.config.availableSpecialists) {
      effectiveSystemPrompt += '\n\n## Available Specialists\n' + this.config.availableSpecialists;
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine test runtime.test.ts -t "Available Specialists"`
Expected: PASS.

- [ ] **Step 6: Wire `availableSpecialists` for the coordinator in `src/index.ts`**

In the `new AgentRuntime({ ... })` construction (~L1700-1765), add this field (place it near `agentRegistry`):

```typescript
      // Specialist roster — appended as "## Available Specialists" for the coordinator.
      // Specialists that opt in via inject_specialists keep the bootstrap ${available_specialists}
      // placeholder (resolved in interpolateRuntimeContext); this runtime path is coordinator-only.
      availableSpecialists: agentConfig.role === 'coordinator' ? agentRegistry.specialistSummary() : undefined,
```

Then, in the coordinator branch of the `interpolateRuntimeContext` call (~L1617-1621), remove the `availableSpecialists: agentRegistry.specialistSummary(),` line — the coordinator no longer resolves that placeholder at bootstrap (it has none). Leave the `inject_specialists` branch (~L1629-1633) untouched.

- [ ] **Step 7: Remove `${available_specialists}` from `agents/coordinator.yaml`**

In the `## Your Team` section, delete the `${available_specialists}` line (L440). Leave the surrounding prose for now (Task 5 restructures it).

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine run typecheck`
Expected: clean.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine add src/agents/runtime.ts src/index.ts agents/coordinator.yaml tests/unit/agents/runtime.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine commit -m "refactor: inject ## Available Specialists as a runtime appendix for the coordinator (#957)"
```

---

## Task 3: Add `Contact ID:` to `## Your Contact Details`; thread `agentContactId`

**Files:**
- Modify: `src/agents/runtime.ts` (`AgentConfig` interface; the `## Your Contact Details` block ~L316-325)
- Modify: `src/index.ts` (coordinator `AgentRuntime` construction)
- Modify: `agents/coordinator.yaml` (reword the `${agent_contact_id}` line ~L27)
- Test: `tests/unit/agents/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/agents/runtime.test.ts`:

```typescript
  it('adds a Contact ID line to ## Your Contact Details when agentContactId is set', async () => {
    const provider = createMockProvider('OK');
    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'Body text.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger: createLogger('error'),
      channelAccounts: { email: 'agent@example.com' },
      agentContactId: '11111111-1111-4111-8111-111111111111',
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-contactid-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-contactid-1',
    });
    await bus.publish('dispatch', task);

    const systemMsg = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0].messages[0]!.content as string;
    expect(systemMsg).toContain('## Your Contact Details');
    expect(systemMsg).toContain('- Contact ID: 11111111-1111-4111-8111-111111111111');
  });

  it('omits the Contact ID line when agentContactId is not provided', async () => {
    const provider = createMockProvider('OK');
    const runtime = new AgentRuntime({
      agentId: 'calendar',
      systemPrompt: 'Specialist body.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger: createLogger('error'),
      channelAccounts: { email: 'agent@example.com' },
      // agentContactId intentionally omitted
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'calendar',
      conversationId: 'conv-contactid-2',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-contactid-2',
    });
    await bus.publish('dispatch', task);

    const systemMsg = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0].messages[0]!.content as string;
    expect(systemMsg).not.toContain('Contact ID:');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine test runtime.test.ts -t "Contact ID"`
Expected: FAIL — `agentContactId` is not a config field and no line is added.

- [ ] **Step 3: Add the `agentContactId` config field**

In `src/agents/runtime.ts` `AgentConfig`, add near `channelAccounts` (~L72):

```typescript
  /** The agent's own contact ID (a UUID). When provided, a "Contact ID: <uuid>" line is
   *  added to the "## Your Contact Details" block so the agent can reference its own
   *  identity for self-directed lookups. Passed only for the coordinator (specialists use
   *  the ${agent_contact_id} bootstrap placeholder). */
  agentContactId?: string;
```

- [ ] **Step 4: Add the Contact ID line to the Your Contact Details block**

In `src/agents/runtime.ts`, the `## Your Contact Details` block (~L316-325) builds `lines`. After the `if (channelAccounts.phone) lines.push(...)` line and before `effectiveSystemPrompt += '\n\n' + lines.join('\n');`, add:

```typescript
      // The agent's own contact ID — used for self-directed entity/calendar lookups.
      // Coordinator-only in practice (passed only for the coordinator in src/index.ts).
      if (this.config.agentContactId) lines.push(`- Contact ID: ${this.config.agentContactId}`);
```

Note: the `## Your Contact Details` block currently only renders when `channelAccounts.email || channelAccounts.phone` is truthy (the enclosing `if`). The coordinator always has an email, so this is fine. (If you want the Contact ID to render even with no channel accounts, that is out of scope — the coordinator always has an email.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine test runtime.test.ts -t "Contact ID"`
Expected: PASS.

- [ ] **Step 6: Wire `agentContactId` for the coordinator in `src/index.ts`**

In the `new AgentRuntime({ ... })` construction, add (near `availableSpecialists` from Task 2):

```typescript
      // The coordinator's own contact ID — surfaced in "## Your Contact Details".
      // Specialists keep the ${agent_contact_id} bootstrap placeholder.
      agentContactId: agentConfig.role === 'coordinator' ? agentIdentityContactId : undefined,
```

Then, in the coordinator branch of the `interpolateRuntimeContext` call (~L1617-1621), remove the `agentContactId: agentIdentityContactId,` line (the coordinator YAML no longer has the inline placeholder). Leave the specialist branches (~L1629-1633, ~L1647-1650) untouched — `calendar.yaml` still uses `${agent_contact_id}` at bootstrap.

- [ ] **Step 7: Reword the `${agent_contact_id}` line in `agents/coordinator.yaml`**

In the `## Your Identity` section (~L26-29), replace:

```
  Your contact ID is ${agent_contact_id}. Use this when "you" or "your" clearly refers
```

with:

```
  Your own contact ID is listed in the "## Your Contact Details" block below. Use it when "you" or "your" clearly refers
```

(Task 5 may reorganize this further, but this keeps the commit coherent.)

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine run typecheck`
Expected: clean.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine add src/agents/runtime.ts src/index.ts agents/coordinator.yaml tests/unit/agents/runtime.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine commit -m "refactor: surface coordinator contact ID in Your Contact Details block (#957)"
```

---

## Task 4: Remove the vestigial executive-voice injection everywhere

**Files:**
- Modify: `src/agents/runtime.ts` (remove exec-voice block ~L259-276; remove config fields ~L57-63; remove import L22)
- Modify: `src/agents/loader.ts` (remove `${executive_voice_block}` branch ~L214-220; remove `executiveVoiceBlock` from context param ~L201; update JSDoc ~L177, L191-193)
- Modify: `src/index.ts` (remove `executiveProfileService`/`executiveDisplayName` from coordinator `AgentRuntime` ~L1730-1734)
- Modify: `agents/coordinator.yaml` (remove `${executive_voice_block}` L395)
- Test: `tests/unit/agents/runtime.test.ts` (remove the two exec-voice tests ~L131-200 + unused import L10)

- [ ] **Step 1: Remove the two executive-voice tests and the unused import**

In `tests/unit/agents/runtime.test.ts`, delete both tests: `fails task when executiveProfileService is provided but not initialized` (~L131-164) and `logs and continues when executive voice block compilation throws` (~L166-200). Then remove the now-unused import at L10: `import type { ExecutiveProfile } from '../../../src/executive/types.js';` (verify with a search that `ExecutiveProfile` has no other use in the file before removing).

- [ ] **Step 2: Remove the executive-voice injection block from `src/agents/runtime.ts`**

Delete the block beginning `// Replace the ${executive_voice_block} placeholder...` through the end of its `if (executiveProfileService) { ... }` (~L259-276).

- [ ] **Step 3: Remove the config fields and import from `src/agents/runtime.ts`**

Remove the `executiveProfileService?` field (~L57-60) and the `executiveDisplayName?` field (~L61-63) from `AgentConfig`. Remove `executiveProfileService` and `executiveDisplayName` from the destructuring in `processTask` (the `const { ... } = this.config;` near L210). Then change the import at L22:

```typescript
import { compileWritingVoiceBlock, type ExecutiveProfileService } from '../executive/service.js';
```

Delete this line entirely (verify `compileWritingVoiceBlock` and `ExecutiveProfileService` have no other use in `runtime.ts` first — a search should show none after Steps 2-3).

- [ ] **Step 4: Remove the `${executive_voice_block}` branch from `src/agents/loader.ts`**

In `interpolateRuntimeContext`, remove the `.replace(/\$\{executive_voice_block\}/g, ...)` clause (~L214-220) and remove `executiveVoiceBlock?: string;` from the `context` param type (~L201). Update the JSDoc: delete the `${executive_voice_block}` bullet (~L177) and the trailing note about per-turn executive-voice replacement (~L191-193).

- [ ] **Step 5: Remove the coordinator exec-voice wiring from `src/index.ts`**

In the coordinator's `new AgentRuntime({ ... })`, delete the `executiveProfileService: agentConfig.role === 'coordinator' ? executiveProfileService : undefined,` and `executiveDisplayName: agentConfig.role === 'coordinator' ? executiveDisplayName : undefined,` lines (~L1730-1734) and their preceding comment. Do NOT remove the `executiveProfileService` construction earlier in the file — the `executive-profile-get`/`executive-profile-update` skills still consume it. If `executiveDisplayName` becomes an unused local after this, remove its declaration too (search to confirm).

- [ ] **Step 6: Remove `${executive_voice_block}` from `agents/coordinator.yaml`**

Delete the `${executive_voice_block}` line (L395) and any now-orphaned surrounding blank line.

- [ ] **Step 7: Run the full unit suite for the touched files + typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine test runtime.test.ts loader.test.ts`
Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine run typecheck`
Expected: PASS; typecheck clean (no unused-import or unused-symbol errors).

- [ ] **Step 8: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine add src/agents/runtime.ts src/agents/loader.ts src/index.ts agents/coordinator.yaml tests/unit/agents/runtime.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine commit -m "refactor: remove vestigial executive-voice block injection from coordinator (#957)"
```

---

## Task 5: Restructure the coordinator prompt into the 5-part taxonomy

This is the core authoring task. The body of `agents/coordinator.yaml` `system_prompt` is reorganized to follow the 5-part taxonomy. Use the **porting checklist table** in the design spec (`docs/wip/2026-06-13-coordinator-decision-spine-design.md`) as the completeness gate: every row must land in its mapped slot. Behavior ports 1:1 except the two intended changes (transfer-ownership rule added; executive-voice already removed in Task 4).

**Files:**
- Modify: `agents/coordinator.yaml` (`system_prompt` body reorganization + `version` bump)
- Test: `tests/unit/agents/loader.test.ts`

- [ ] **Step 1: Update the loader tests that assert `${office_identity_block}` is present**

In `tests/unit/agents/loader.test.ts`, the first two tests (~L10-29) assert `config.system_prompt` contains `${office_identity_block}`. Replace those two assertions. Rewrite the second test (`uses office_identity_block token instead of persona fields`) into a placeholder-guard test:

```typescript
  it('coordinator.yaml carries no ${...} runtime placeholders', () => {
    // Runtime blocks (identity, security, specialists, contact ID) are now always-injected
    // by AgentRuntime at fixed positions — the YAML must be placeholder-free (#957).
    const config = loadAgentConfig(path.join(agentsDir, 'coordinator.yaml'));
    expect(config.system_prompt).not.toContain('${office_identity_block}');
    expect(config.system_prompt).not.toContain('${security_context_block}');
    expect(config.system_prompt).not.toContain('${executive_voice_block}');
    expect(config.system_prompt).not.toContain('${available_specialists}');
    expect(config.system_prompt).not.toContain('${agent_contact_id}');
    // No legacy persona tokens either.
    expect(config.system_prompt).not.toContain('${persona.');
  });
```

In the first test (`loads and parses coordinator.yaml`, ~L10-17), remove the line `expect(config.system_prompt).toContain('${office_identity_block}');` and replace it with a meaningful-content assertion that survives the restructure:

```typescript
    // System prompt is meaningful and reflects the routing-decision spine.
    expect(config.system_prompt).toContain('Transfer-ownership');
```

- [ ] **Step 2: Run the loader tests to verify the guard fails (placeholders still present pre-rewrite)**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine test loader.test.ts -t "no \${...} runtime placeholders"`
Expected: After Tasks 1-4 all five placeholders are already gone, so this guard should already PASS. The `Transfer-ownership` assertion in the first test will FAIL until Step 3 adds that text. (If any placeholder assertion fails, a Task 1-4 surgical removal was missed — fix that first.)

- [ ] **Step 3: Rewrite the `system_prompt` body into the 5-part taxonomy**

Reorganize the body into these sections, in this order. Move existing prose into the mapped slot per the porting checklist; do not reword ported content beyond what's needed to fit the new headers. The **net-new** text (the routing spine, the transfer-ownership rule, and the unified surfacing discipline) is given verbatim below — paste it as written.

**Section order:**

```
## Who I am
  (persona/voice — port: Persona & Communication Style, Audience Awareness, Your Identity
   contact-ID usage, Date & Time)

## The Routing Decision
  (NET-NEW spine text below; then port: Pronoun Resolution, Active Outbound Context &
   Delegation [resolved], self-contained-vs-reply-shaped test, Contact Intelligence
   "brief me", CEO Inbox Requests, delegation acknowledgment, specialist clarification)

## What I Do Directly
  (port: Memory, Configuration [when-to-use], Scheduling & Tasks, Email [own account],
   Google Workspace, Reaching the Principal, Data Protection, Pending-approval handling,
   Capability Discovery, Guidelines)

## What I Proactively Surface
  (NET-NEW unified discipline below; the per-item handling mechanics stay in
   "What I Do Directly")

## Reference
  (port the mechanics: config-store namespace syntax, email account-selection rules,
   email threading, Drive-upload steps, context_bridge JSON shape, decay-warning phrasings,
   Account Identity for Tool Calls)
```

**NET-NEW — paste verbatim at the top of `## The Routing Decision`:**

```
  ## The Routing Decision
  For every inbound message, choose exactly one of three responses and stay the single
  voice the person hears. This is your core function.

  1. **Handle directly** — the request is within my own capabilities (memory, config,
     simple Q&A, my own email/calendar/workspace). I do it and reply.
  2. **Borrow-then-answer** — I pull information or work from a specialist (the "brief me"
     pattern), then *I* compose the reply in my own voice. The specialist informs my
     answer; it does not take over the conversation. Briefing the contacts specialist to
     resolve a person, or asking the ceo-inbox specialist to draft a reply I then relay,
     are borrow-then-answer hand-offs.
  3. **Transfer-ownership** — I hand the *entire* interaction to a specialist that owns
     its lifecycle: doing the work, sending confirmations, marking it complete, and
     releasing the outbound-context entry. I route it and do **not** reply myself.

  **The transfer-ownership reply rule (do not violate):** any reply to something I sent on
  a specialist's behalf — i.e. an inbound that matches an [ACTIVE OUTBOUND CONTEXT] entry
  with a `delegation_hint` — is **always** transfer-ownership. I route it to that
  specialist and never answer it myself, even for a trivial "yes", "no", or "sounds good",
  and even if I could answer it. The delegation hint is a binding contract: the specialist
  owns the full state lifecycle for that conversation. Pass the CEO's full message and the
  entry_id. Do not run research, answer questions, or send any reply before delegating.
```

**NET-NEW — paste verbatim as the whole of `## What I Proactively Surface`:**

```
  ## What I Proactively Surface
  When talking to the CEO, I keep one eye on a backlog of things that may need their
  attention: held messages from unknown senders, knowledge that's going stale (decay
  warnings), pending approval requests, and queued tasks waiting on them. One unified
  discipline governs all of them:

  - **Surface the oldest item, one per turn.** Don't list everything at once; mention the
    single oldest pending item of the most relevant kind.
  - **Wait for a natural pause.** Don't interrupt an urgent or in-flight topic to raise
    backlog — fold it in when the current thread reaches a natural stopping point.
  - **Be specific but brief.** One clause describing the item, not a paragraph. If the
    underlying data was truncated, qualify your description ("appears to be…").
  - **Flag sensitive items explicitly** — calendar access, data export, financial actions,
    or credential requests get called out, not buried.

  The mechanics for acting on each kind (identifying/dismissing/blocking held messages,
  confirming or dismissing decay warnings, approving/denying pending actions, listing the
  backlog) are under "What I Do Directly". This section governs only *when and how* I raise
  them.
```

When porting the **Active Outbound Context** section into `## The Routing Decision`, resolve the contradiction: the old L224 "Always delegate" / L231 "handle directly" / L232 "handle normally" clauses are replaced by the three-way decision above. A matched entry *with* a `delegation_hint` → transfer-ownership (the rule above). A matched entry *without* a `delegation_hint` → handle directly or borrow-then-answer as the content warrants. Clearly unrelated to all entries → the normal three-way decision. Keep the `context-bridge-release` guidance and the specialist-clarification resume flow (move the `context_bridge` JSON shape to Reference).

When porting the per-kind surfacing prose (Held Messages, Decay Warnings, Pending Approvals, backlog), keep each kind's *action mechanics* under "What I Do Directly" and let the unified discipline above replace the four near-duplicate "surface the oldest, one per turn, don't interrupt" paragraphs.

- [ ] **Step 4: Bump the version**

In `agents/coordinator.yaml`, change `version: "0.6.0"` to `version: "0.7.0"`.

- [ ] **Step 5: Verify the YAML parses and the porting checklist is complete**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine test loader.test.ts`
Expected: PASS (placeholder guard + `Transfer-ownership` content assertion + YAML parses).

Then manually walk the porting checklist table in the design spec: for each of the ~25 rows, confirm the prose is present in its mapped slot in the rewritten YAML. This is the acceptance-criterion "porting checklist complete" gate. Note any row you intentionally dropped (only executive-voice should be dropped).

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine add agents/coordinator.yaml tests/unit/agents/loader.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine commit -m "feat: re-derive coordinator prompt around the three-way routing decision (#957)"
```

---

## Task 6: CHANGELOG + full verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add CHANGELOG entries**

Under `## [Unreleased]` in `CHANGELOG.md`, add (creating the `### Changed` / `### Removed` subsections if absent):

```markdown
### Changed

- **Coordinator prompt** — re-derived around an explicit three-way routing decision
  (handle directly / borrow-then-answer / transfer-ownership). A reply to a
  delegation-hinted outbound is now always transferred to the owning specialist, fixing
  systemic under-delegation of debrief/reschedule replies. (#957)

### Removed

- **Coordinator executive-voice block** — removed the vestigial `${executive_voice_block}`
  injection; CEO-voice drafting lives in the ceo-inbox specialist. (#957)
```

- [ ] **Step 2: Run the full test suite**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine test`
Expected: all PASS. Investigate and fix any failure before proceeding.

- [ ] **Step 3: Run typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-decision-spine commit -m "docs: changelog for coordinator decision-spine restructure (#957)"
```

---

## Task 7: Audit-log baseline measurement (validation)

This produces the "before" number for the acceptance criterion. It depends on prod
audit-log access — **pause and ask Joseph** for the access method (DB query access, an
export, or a script) before running. The "after" number is post-deploy.

- [ ] **Step 1: Confirm access** — ask Joseph how to query the prod audit log (the
  `prod-debug` skill facts in this project may provide the connection). Do not guess
  credentials.

- [ ] **Step 2: Measure the baseline** — query the audit log for the rate at which CEO
  replies to delegation-hinted outbounds (debrief, calendar-reschedule, specialist-
  clarification) produced a `delegate`→specialist event vs. a direct coordinator reply,
  over a representative recent window (e.g. Apr–Jun, matching #957's evidence). Record the
  exact query and the near-zero baseline number.

- [ ] **Step 3: Document** — add the query and baseline to the PR description, with a note
  that the post-deploy "after" is measured by re-running the same query, and that this
  acceptance checkbox stays open until then.

---

## Pre-PR: review + manual smoke

Before opening the PR (per the global auto-review rule):

- [ ] Run `pr-review-toolkit:code-reviewer` and `pr-review-toolkit:silent-failure-hunter`
  in parallel on the branch diff; address high-priority findings.
- [ ] Manual smoke pass (local run): email reply, contacts "brief me", memory store/recall,
  scheduling, held-message surfacing, approval handling — confirm no regression and that a
  reply to a delegation-hinted outbound now delegates.
- [ ] Open the PR with `Closes #957` in the Summary; confirm CI started.

---

## Self-Review Notes (completed by plan author)

- **Spec coverage:** every acceptance criterion in #957 maps to a task — taxonomy reorg
  (Task 5), hand-off patterns + transfer rule (Task 5), contradiction resolved (Task 5),
  unified surfacing (Task 5), Reference region (Task 5), always-injected blocks + failsafe
  removal + loader/runtime tests (Tasks 1-4), porting checklist (Task 5 Step 5), baseline
  metric (Task 7), version bump + CHANGELOG + typecheck/tests (Tasks 5-6).
- **Coherence:** Tasks 1-4 each pair a code change with the matching surgical YAML
  placeholder removal so every commit builds and passes tests; Task 5 supersedes the
  surgical wordings with the full restructure.
- **Type consistency:** new config fields `availableSpecialists?: string` and
  `agentContactId?: string` are referenced identically in runtime.ts and index.ts.
