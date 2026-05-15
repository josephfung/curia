# Principal Bypass for Autonomy Gates A and B — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a task is originated by the principal (CEO), skip autonomy Gates A and B so that direct CEO instructions are never blocked by the autonomy score.

**Architecture:** Single edit to `src/skills/execution.ts` — wrap the existing Gate A and Gate B logic in an `else` branch gated by `isPrincipalOriginated()`. The helper is already imported. No schema changes, no new files.

**Tech Stack:** TypeScript, Vitest

**Worktree:** `/Users/josephfung/Projects/curia-principal-bypass` (branch `fix/principal-bypass-autonomy-gate`)

---

### Task 1: Write the three failing tests

**Files:**
- Modify: `src/skills/execution.test.ts` — add three cases to the existing `'autonomy gates'` describe block (after the last `it(...)` in that block, before the closing `}`).

- [ ] **Step 1.1: Add the three test cases**

Open `src/skills/execution.test.ts`. The `'autonomy gates'` describe block ends just before the `// ---------------------------------------------------------------------------` comment for `humanApproved bypass tests` (around line 543). Add these three `it(...)` blocks inside the `'autonomy gates'` describe, immediately before its closing `});`:

```ts
  it('skips gates A and B when task is principal-originated (Gate B territory)', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('ok');
    // calendar-create-event uses action_risk: 'high' → requires score 80. Score 74 would normally block.
    registry.register(makeRiskyManifest('calendar-create-event', 'high'), handler);

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(74),
    });

    const result = await layer.invoke('calendar-create-event', {}, undefined, {
      taskMetadata: {
        originator: {
          contactId: 'ceo-contact-id',
          systemRole: 'principal' as const,
          channel: 'email',
          initiatedAt: new Date().toISOString(),
        },
      },
    });

    expect(result.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledOnce();
  });

  it('skips gates A and B when task is principal-originated (Gate A territory)', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('ok');
    // score 50 triggers Gate A (< 60 blocks all non-none) — principal should still pass
    registry.register(makeRiskyManifest('send-email', 'low'), handler);

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(50),
    });

    const result = await layer.invoke('send-email', {}, undefined, {
      taskMetadata: {
        originator: {
          contactId: 'ceo-contact-id',
          systemRole: 'principal' as const,
          channel: 'email',
          initiatedAt: new Date().toISOString(),
        },
      },
    });

    expect(result.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledOnce();
  });

  it('does NOT bypass gates for agent-originated tasks', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('should not run');
    registry.register(makeRiskyManifest('calendar-create-event', 'high'), handler); // requires 80

    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;
    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(74), // below 80 — should block non-principal
      bus: mockBus,
    });

    const result = await layer.invoke('calendar-create-event', {}, undefined, {
      taskMetadata: {
        originator: {
          contactId: 'agent-contact-id',
          systemRole: 'agent' as const,
          channel: 'internal',
          initiatedAt: new Date().toISOString(),
        },
      },
    });

    expect(result.success).toBe(false);
    expect(handler.execute).not.toHaveBeenCalled();
  });
```

- [ ] **Step 1.2: Run the new tests to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/curia-principal-bypass test -- --reporter=verbose src/skills/execution.test.ts 2>&1 | tail -30
```

Expected: the two `'skips gates'` tests FAIL with `expected false to be true` (gate fires instead of bypassing). The `'does NOT bypass'` test should PASS (it exercises existing behaviour).

---

### Task 2: Implement the principal bypass

**Files:**
- Modify: `src/skills/execution.ts` — wrap Gates A and B in an `else` branch

- [ ] **Step 2.1: Replace the gate block**

In `src/skills/execution.ts`, find this exact block (currently starting around line 346):

```ts
      if (autonomyConfig !== null) {
        const currentScore = autonomyConfig.score;

        // Gate A: Full restriction — score < 60 blocks all non-read skills.
        // action_risk: 'none' is exempt (reads, retrieval, summarisation).
        if (currentScore < 60 && manifest.action_risk !== 'none') {
```

Replace the entire `if (autonomyConfig !== null) { ... }` block with this:

```ts
      if (autonomyConfig !== null) {
        const currentScore = autonomyConfig.score;

        // Principal bypass — if the task was originated by the principal (CEO), skip gates A and B.
        // The autonomy gate governs *autonomous* behavior; a direct CEO instruction overrides it
        // by intent. Log at info so bypasses are visible in production.
        if (isPrincipalOriginated(options?.taskMetadata)) {
          skillLogger.info(
            { skillName, currentScore },
            'autonomy gate: skipped — task originated by principal',
          );
        } else {
          // Gate A: Full restriction — score < 60 blocks all non-read skills.
          // action_risk: 'none' is exempt (reads, retrieval, summarisation).
          if (currentScore < 60 && manifest.action_risk !== 'none') {
            skillLogger.info(
              { skillName, currentScore, actionRisk: manifest.action_risk },
              'autonomy gate: skill blocked — agent is in restricted mode (score < 60)',
            );
            if (this.bus) {
              this.bus.publish('execution', createAutonomySkillBlocked({
                skillName,
                actionRisk: manifest.action_risk,
                currentScore,
                requiredScore: 60,
                agentId: options?.agentId,
                taskEventId: options?.taskEventId,
              })).catch((err) => {
                skillLogger.warn({ err, skillName }, 'autonomy gate: failed to publish autonomy.skill_blocked event');
              });
            }
            // Note: `input` here is post-timestamp-normalization (mutated in-place above).
            // The stored payload in autonomy_action_log will contain normalized timestamps,
            // which is correct — re-normalization on approve-action re-invocation is a no-op.
            const gateAError = await this.buildGateError(
              skillName, input, currentScore, 60, manifest.action_risk, options, skillLogger,
            );
            return {
              success: false,
              error: this.wrapSkillError(gateAError),
            };
          }

          // Gate B: Per-skill action_risk threshold.
          const requiredScore = AutonomyService.minScoreForActionRisk(manifest.action_risk);
          if (currentScore < requiredScore) {
            skillLogger.info(
              { skillName, currentScore, requiredScore, actionRisk: manifest.action_risk },
              'autonomy gate: skill blocked — score below action_risk threshold',
            );
            if (this.bus) {
              this.bus.publish('execution', createAutonomySkillBlocked({
                skillName,
                actionRisk: manifest.action_risk,
                currentScore,
                requiredScore,
                agentId: options?.agentId,
                taskEventId: options?.taskEventId,
              })).catch((err) => {
                skillLogger.warn({ err, skillName }, 'autonomy gate: failed to publish autonomy.skill_blocked event');
              });
            }
            // Note: same post-normalization `input` as Gate A — see comment above.
            const gateBError = await this.buildGateError(
              skillName, input, currentScore, requiredScore, manifest.action_risk, options, skillLogger,
            );
            return {
              success: false,
              error: this.wrapSkillError(gateBError),
            };
          }
        }
      } else {
```

> **Tip:** The closing `} else {` at the end connects to the existing `autonomyConfig is null — pre-migration or empty table. Fail-open.` warn block — do not change that part.

- [ ] **Step 2.2: Run the three new tests — all should now pass**

```bash
npm --prefix /Users/josephfung/Projects/curia-principal-bypass test -- --reporter=verbose src/skills/execution.test.ts 2>&1 | tail -30
```

Expected: all three new tests PASS.

- [ ] **Step 2.3: Run the full test suite — no regressions**

```bash
npm --prefix /Users/josephfung/Projects/curia-principal-bypass test 2>&1 | tail -20
```

Expected: all tests pass. If any fail, fix before continuing.

- [ ] **Step 2.4: Commit**

```bash
git -C /Users/josephfung/Projects/curia-principal-bypass add src/skills/execution.ts src/skills/execution.test.ts
git -C /Users/josephfung/Projects/curia-principal-bypass commit -m "fix: bypass autonomy gates A and B for principal-originated tasks"
```
