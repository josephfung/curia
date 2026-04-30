# Autonomy Hard Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire hard enforcement gates into the execution layer and outbound gateway so the autonomy score is not advisory-only.

**Architecture:** Three gate layers enforce `action_risk` thresholds: full-restriction (score < 60), per-skill threshold, and outbound gateway (score < 70). Gates are self-contained — each reads the live autonomy score per invocation. Fail-open when the autonomy service is unavailable.

**Tech Stack:** TypeScript/ESM, vitest, existing AutonomyService + ExecutionLayer + OutboundGateway + EventBus

**Spec:** `docs/wip/2026-04-30-autonomy-hard-gates-design.md`
**Issue:** #147

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/bus/events.ts` | Add `autonomy.skill_blocked` and `autonomy.send_blocked` event types, payloads, factories |
| Modify | `src/bus/permissions.ts` | Register new events in publish/subscribe allowlists |
| Modify | `src/skills/registry.ts` | Make `action_risk` rejection explicit (missing → throw) |
| Modify | `src/skills/execution.ts` | Add autonomy gates to `invoke()` |
| Modify | `src/skills/outbound-gateway.ts` | Add score < 70 gate to `send()`, accept `autonomyService` in config |
| Modify | `src/index.ts` | Pass `autonomyService` to `OutboundGateway` constructor |
| Modify | `src/skills/execution.test.ts` | Tests for autonomy gates |
| Modify | `tests/unit/skills/outbound-gateway.test.ts` | Tests for send gate |
| Modify | `docs/dev/adding-a-skill.md` | Update Phase 2 language to present tense |
| Modify | `docs/specs/14-autonomy-engine.md` | Update Phase 2 status to "Implemented" |
| Modify | `docs/specs/03-skills-and-execution.md` | Update Phase 2 reference |
| Modify | `CLAUDE.md` | Update "Autonomy Awareness" section |
| Modify | `CONTRIBUTING.md` | Update "Adding a New Skill" section |
| Modify | `CHANGELOG.md` | Add unreleased entries |

---

### Task 1: Bus Events — Payloads, Types, and Factories

**Files:**
- Modify: `src/bus/events.ts`
- Modify: `src/bus/permissions.ts`

- [ ] **Step 1: Add payload interfaces to `src/bus/events.ts`**

Add after the `SecretAccessedPayload` interface (around line 357):

```ts
// AutonomySkillBlockedPayload — published by the execution layer when a skill
// invocation is blocked because the live autonomy score is below the skill's
// action_risk threshold. Advisory-only — the agent receives a { success: false }
// result and can escalate to the CEO.
interface AutonomySkillBlockedPayload {
  skillName: string;
  actionRisk: ActionRisk;
  currentScore: number;
  requiredScore: number;
  agentId?: string;
  taskEventId?: string;
}

// AutonomySendBlockedPayload — published by the outbound gateway when an outbound
// send is blocked because the live autonomy score is below 70. The agent receives
// a { success: false, blockedReason } result.
interface AutonomySendBlockedPayload {
  channel: string;
  currentScore: number;
  requiredScore: number;
  agentId?: string;
  taskEventId?: string;
}
```

Note: `ActionRisk` is defined in `src/skills/types.ts`. Import it as a type at the top of `events.ts`:

```ts
import type { ActionRisk } from '../skills/types.js';
```

- [ ] **Step 2: Add event interfaces to `src/bus/events.ts`**

Add after the `SecretAccessedEvent` interface (around line 597):

```ts
// AutonomySkillBlockedEvent — execution layer blocked a skill invocation
// due to insufficient autonomy score.
export interface AutonomySkillBlockedEvent extends BaseEvent {
  type: 'autonomy.skill_blocked';
  sourceLayer: 'execution';
  payload: AutonomySkillBlockedPayload;
}

// AutonomySendBlockedEvent — outbound gateway blocked a send due to
// insufficient autonomy score (< 70).
export interface AutonomySendBlockedEvent extends BaseEvent {
  type: 'autonomy.send_blocked';
  sourceLayer: 'dispatch';
  payload: AutonomySendBlockedPayload;
}
```

- [ ] **Step 3: Add to `BusEvent` union in `src/bus/events.ts`**

Add to the `BusEvent` type union (around line 657, before the semicolon):

```ts
  | AutonomySkillBlockedEvent  // Autonomy Phase 2: skill blocked by action_risk gate
  | AutonomySendBlockedEvent   // Autonomy Phase 2: outbound send blocked by score < 70 gate
```

- [ ] **Step 4: Add factory functions to `src/bus/events.ts`**

Add after `createSecretAccessed` (around line 1071):

```ts
export function createAutonomySkillBlocked(
  payload: AutonomySkillBlockedPayload,
  parentEventId?: string,
): AutonomySkillBlockedEvent {
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'autonomy.skill_blocked',
    sourceLayer: 'execution',
    payload,
    parentEventId,
  };
}

export function createAutonomySendBlocked(
  payload: AutonomySendBlockedPayload,
  parentEventId?: string,
): AutonomySendBlockedEvent {
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'autonomy.send_blocked',
    sourceLayer: 'dispatch',
    payload,
    parentEventId,
  };
}
```

- [ ] **Step 5: Register events in `src/bus/permissions.ts`**

Add `'autonomy.skill_blocked'` to the `execution` layer's publish set.
Add `'autonomy.send_blocked'` to the `dispatch` layer's publish set.
Add both to the `system` layer's publish and subscribe sets.

- [ ] **Step 6: Run typecheck**

Run: `npx --prefix <worktree> tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 7: Commit**

```
feat: add autonomy.skill_blocked and autonomy.send_blocked bus events

Two new event types for Phase 2 hard gates. Published by the execution
layer and outbound gateway respectively when skill/send invocations
are blocked by the autonomy score.
```

---

### Task 2: SkillRegistry — Make `action_risk` Required at Runtime

**Files:**
- Modify: `src/skills/registry.ts`

- [ ] **Step 1: Update `register()` to reject missing `action_risk`**

In `src/skills/registry.ts`, change the existing guard at line 48:

```ts
// BEFORE:
if (manifest.action_risk !== undefined) {
  const risk = manifest.action_risk;
  // ... validation ...
}

// AFTER:
if (manifest.action_risk === undefined || manifest.action_risk === null) {
  throw new Error(
    `Skill '${manifest.name}' is missing required field 'action_risk'. ` +
    `All skills must declare action_risk. See docs/dev/adding-a-skill.md.`,
  );
}
const risk = manifest.action_risk;
if (typeof risk === 'number') {
  if (!Number.isInteger(risk) || risk < 0 || risk > 100) {
    throw new Error(
      `Skill '${manifest.name}' has invalid action_risk: ${risk}. ` +
      `Numeric action_risk must be an integer between 0 and 100.`,
    );
  }
} else if (!ACTION_RISK_LABELS.has(risk as string)) {
  throw new Error(
    `Skill '${manifest.name}' has invalid action_risk label: "${String(risk)}". ` +
    `Expected one of: ${[...ACTION_RISK_LABELS].join(', ')}.`,
  );
}
```

Note: The outer `if` guard is removed, and the missing-field check becomes an explicit rejection. The value-validation logic is unchanged.

- [ ] **Step 2: Run existing tests**

Run: `npx --prefix <worktree> vitest run src/skills/loader.test.ts tests/unit/startup/validator.test.ts`
Expected: all pass. The startup validator (JSON Schema) already catches missing `action_risk` at boot time. These tests confirm the schema path still works. The registry runtime path is tested in Task 4.

- [ ] **Step 3: Commit**

```
feat: enforce action_risk as required in SkillRegistry.register()

Previously the runtime validation was guarded by `if (action_risk !== undefined)`,
meaning a missing field was silently accepted. Now it throws at registration,
matching the TypeScript type and the JSON Schema validator.
```

---

### Task 3: Execution Layer — Autonomy Gates (Tests First)

**Files:**
- Modify: `src/skills/execution.test.ts`

- [ ] **Step 1: Add a helper to build an AutonomyService stub**

Add at the top of `execution.test.ts`, after the existing imports:

```ts
import type { AutonomyService, AutonomyConfig } from '../autonomy/autonomy-service.js';
```

Add after the `makeHandler` helper:

```ts
/** Build a stub AutonomyService that returns a fixed config. */
function makeAutonomyService(score: number): AutonomyService {
  const config: AutonomyConfig = {
    score,
    band: score >= 90 ? 'full' : score >= 80 ? 'spot-check' : score >= 70 ? 'approval-required' : score >= 60 ? 'draft-only' : 'restricted',
    updatedAt: new Date(),
    updatedBy: 'test',
  };
  return {
    getConfig: vi.fn().mockResolvedValue(config),
  } as unknown as AutonomyService;
}

/** Build a manifest with a specific action_risk. */
function makeRiskyManifest(name: string, actionRisk: 'none' | 'low' | 'medium' | 'high' | 'critical'): SkillManifest {
  return {
    name,
    description: `${name} description`,
    version: '1.0.0',
    sensitivity: 'normal',
    action_risk: actionRisk,
    inputs: {},
    outputs: {},
    permissions: [],
    secrets: [],
    timeout: 5000,
  };
}
```

- [ ] **Step 2: Write failing tests for the autonomy gates**

Add a new `describe` block at the end of `execution.test.ts`:

```ts
// ---------------------------------------------------------------------------
// Autonomy gates
// ---------------------------------------------------------------------------

describe('autonomy gates', () => {
  it('blocks skill when score is below action_risk threshold', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('should not run');
    registry.register(makeRiskyManifest('send-email', 'medium'), handler); // requires 70

    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;
    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65), // below 70
      bus: mockBus,
    });

    const result = await layer.invoke('send-email', {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('autonomy');
      expect(result.error).toContain('70');
    }
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it('allows skill when score meets action_risk threshold', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('ok');
    registry.register(makeRiskyManifest('send-email', 'medium'), handler); // requires 70

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(75), // above 70
    });

    const result = await layer.invoke('send-email', {});

    expect(result.success).toBe(true);
  });

  it('always allows action_risk: none regardless of score', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('ok');
    registry.register(makeRiskyManifest('search-docs', 'none'), handler);

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(10), // very low
    });

    const result = await layer.invoke('search-docs', {});

    expect(result.success).toBe(true);
  });

  it('blocks all non-none skills when score < 60 (full restriction)', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('should not run');
    registry.register(makeRiskyManifest('store-fact', 'low'), handler); // requires 60

    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;
    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(55), // below 60
      bus: mockBus,
    });

    const result = await layer.invoke('store-fact', {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('restricted');
    }
    expect(handler.execute).not.toHaveBeenCalled();
  });

  it('emits autonomy.skill_blocked event when skill is blocked', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('send-email', 'medium'), makeHandler('no'));

    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;
    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
      bus: mockBus,
    });

    await layer.invoke('send-email', {});

    expect(mockBus.publish).toHaveBeenCalledWith(
      'execution',
      expect.objectContaining({
        type: 'autonomy.skill_blocked',
        payload: expect.objectContaining({
          skillName: 'send-email',
          currentScore: 65,
          requiredScore: 70,
        }),
      }),
    );
  });

  it('skips gate when autonomyService is not wired (fail-open)', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('ok');
    registry.register(makeRiskyManifest('send-email', 'medium'), handler);

    // No autonomyService — gate should be skipped
    const layer = new ExecutionLayer(registry, logger);

    const result = await layer.invoke('send-email', {});

    expect(result.success).toBe(true);
  });

  it('skips gate when getConfig returns null (pre-migration)', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('ok');
    registry.register(makeRiskyManifest('send-email', 'medium'), handler);

    const nullService = {
      getConfig: vi.fn().mockResolvedValue(null),
    } as unknown as AutonomyService;
    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: nullService,
    });

    const result = await layer.invoke('send-email', {});

    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx --prefix <worktree> vitest run src/skills/execution.test.ts`
Expected: the new `autonomy gates` tests FAIL (gates not implemented yet). Existing tests pass.

- [ ] **Step 4: Commit failing tests**

```
test: add failing tests for execution layer autonomy gates

Tests for: score-based blocking, action_risk threshold, full restriction
(< 60), none exemption, bus event emission, fail-open when service
is unavailable or returns null.
```

---

### Task 4: Execution Layer — Implement Gates

**Files:**
- Modify: `src/skills/execution.ts`

- [ ] **Step 1: Add import for the event factory**

Add to the imports at the top of `execution.ts`:

```ts
import { createAutonomySkillBlocked } from '../bus/events.js';
```

Change the existing `import type { AutonomyService }` (line 37) to a value import and add `AutonomyConfig`:

```ts
import { AutonomyService } from '../autonomy/autonomy-service.js';
import type { AutonomyConfig } from '../autonomy/autonomy-service.js';
```

(Value import needed to call the static method `AutonomyService.minScoreForActionRisk()`.)

- [ ] **Step 2: Add autonomy gates to `invoke()`**

In `src/skills/execution.ts`, inside the `invoke()` method, add the following block **after** the elevated-skill gate (after the `if (manifest.sensitivity === 'elevated')` block, around line 239) and **before** the `// Build the sandboxed context` comment:

```ts
    // Autonomy gates — Phase 2 hard enforcement.
    // Read the live score once per invocation. Fail-open if the service is not
    // wired or the config table doesn't exist yet (getConfig returns null).
    if (this.autonomyService) {
      let autonomyConfig: AutonomyConfig | null = null;
      try {
        autonomyConfig = await this.autonomyService.getConfig();
      } catch (err) {
        // DB error reading autonomy_config — fail-open with a warn log.
        // A transient DB issue should not silently disable the agent.
        skillLogger.warn({ err, skillName }, 'autonomy gate: failed to read autonomy_config — skipping gate (fail-open)');
      }

      if (autonomyConfig !== null) {
        const currentScore = autonomyConfig.score;

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
          return {
            success: false,
            error: this.wrapSkillError(
              `Skill '${skillName}' blocked — autonomy score is ${currentScore} (restricted mode). ` +
              `All non-read skills require a score of at least 60. ` +
              `The CEO can raise the score with the set-autonomy skill.`,
            ),
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
          return {
            success: false,
            error: this.wrapSkillError(
              `Skill '${skillName}' blocked — autonomy score is ${currentScore}, ` +
              `but this skill (action_risk: ${String(manifest.action_risk)}) requires ${requiredScore}. ` +
              `The CEO can raise the score with the set-autonomy skill.`,
            ),
          };
        }
      } else {
        // autonomyConfig is null — pre-migration or empty table. Fail-open.
        skillLogger.warn({ skillName }, 'autonomy gate: autonomy_config not found — skipping gate (fail-open, pre-migration?)');
      }
    }
```

- [ ] **Step 3: Run all tests**

Run: `npx --prefix <worktree> vitest run src/skills/execution.test.ts`
Expected: all tests pass, including the new autonomy gate tests.

- [ ] **Step 4: Run typecheck**

Run: `npx --prefix <worktree> tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```
feat: add autonomy gates to execution layer

Two gates in invoke(): full-restriction (score < 60, all non-read
skills blocked) and per-skill action_risk threshold. Fail-open when
autonomy service is unavailable. Emits autonomy.skill_blocked.

Closes the execution-layer portion of #147.
```

---

### Task 5: OutboundGateway — Score < 70 Gate (Tests First)

**Files:**
- Modify: `tests/unit/skills/outbound-gateway.test.ts`

- [ ] **Step 1: Add AutonomyService import and stub helper**

Add at the top of the test file:

```ts
import type { AutonomyService, AutonomyConfig } from '../../../src/autonomy/autonomy-service.js';
```

Add after the `createMocks()` function:

```ts
/** Build a stub AutonomyService that returns a fixed score. */
function makeAutonomyService(score: number): AutonomyService {
  const config: AutonomyConfig = {
    score,
    band: score >= 90 ? 'full' : score >= 80 ? 'spot-check' : score >= 70 ? 'approval-required' : score >= 60 ? 'draft-only' : 'restricted',
    updatedAt: new Date(),
    updatedBy: 'test',
  };
  return {
    getConfig: vi.fn().mockResolvedValue(config),
  } as unknown as AutonomyService;
}
```

- [ ] **Step 2: Write failing tests for the send gate**

Add a new `describe` block at the end of the file:

```ts
describe('autonomy gate on send()', () => {
  it('blocks send when score < 70', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'Hi there!',
    });

    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain('autonomy');
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
    expect(mocks.contactService.resolveByChannelIdentity).not.toHaveBeenCalled();
  });

  it('allows send when score >= 70', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(75),
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'Hi there!',
    });

    expect(result.success).toBe(true);
  });

  it('emits autonomy.send_blocked event when send is blocked', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    await gateway.send({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'Hi there!',
    });

    expect(mocks.bus.publish).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        type: 'autonomy.send_blocked',
        payload: expect.objectContaining({
          channel: 'email',
          currentScore: 65,
          requiredScore: 70,
        }),
      }),
    );
  });

  it('skips gate when autonomyService is not wired (fail-open)', async () => {
    const mocks = createMocks();
    // No autonomyService — existing tests already exercise this path.
    // This test makes the fail-open behavior explicit.
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      // autonomyService intentionally omitted
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'Hi there!',
    });

    expect(result.success).toBe(true);
  });

  it('does not gate createEmailDraft', async () => {
    const mocks = createMocks();
    (mocks.nylasClient as unknown as { createDraft: ReturnType<typeof vi.fn> }).createDraft =
      vi.fn().mockResolvedValue({ id: 'draft-1' });

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(50), // well below 70
    });

    const result = await gateway.createEmailDraft({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'Draft body',
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBe('draft-1');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx --prefix <worktree> vitest run tests/unit/skills/outbound-gateway.test.ts`
Expected: the new `autonomy gate on send()` tests FAIL (gate not implemented yet). Existing tests pass.

- [ ] **Step 4: Commit failing tests**

```
test: add failing tests for outbound gateway autonomy gate

Tests for: score < 70 blocks send, score >= 70 allows send, event
emission, fail-open when service is absent, createEmailDraft is
unaffected.
```

---

### Task 6: OutboundGateway — Implement Gate

**Files:**
- Modify: `src/skills/outbound-gateway.ts`

- [ ] **Step 1: Add imports**

Add to the imports at the top of `outbound-gateway.ts`:

```ts
import type { AutonomyService } from '../autonomy/autonomy-service.js';
import { createAutonomySendBlocked } from '../bus/events.js';
```

- [ ] **Step 2: Add `autonomyService` to `OutboundGatewayConfig`**

Add to the `OutboundGatewayConfig` interface:

```ts
  /**
   * Autonomy service — used to enforce the score < 70 outbound gate.
   * When the live score is below 70, send() blocks the dispatch and returns
   * an advisory. Optional — when absent, the gate is skipped (fail-open).
   */
  autonomyService?: AutonomyService;
```

- [ ] **Step 3: Store in class fields**

Add a new private field to the `OutboundGateway` class:

```ts
  private readonly autonomyService?: AutonomyService;
```

In the constructor, assign it:

```ts
    this.autonomyService = config.autonomyService;
```

- [ ] **Step 4: Add gate to top of `send()`**

In the `send()` method, add the following block **before** the `const recipientId = ...` line (at the very top of `send()`, before Step 1 comments):

```ts
    // ------------------------------------------------------------------
    // Step 0: Autonomy gate — score < 70 blocks all outbound sends
    // ------------------------------------------------------------------
    // Belt-and-suspenders for medium+ skills: even if the execution layer
    // allowed the skill, the gateway independently blocks the actual send
    // when the score is too low. Fail-open if the service is not wired
    // or the config table is missing.
    if (this.autonomyService) {
      try {
        const autonomyConfig = await this.autonomyService.getConfig();
        if (autonomyConfig !== null && autonomyConfig.score < 70) {
          this.log.info(
            { channel: request.channel, currentScore: autonomyConfig.score },
            'outbound-gateway: send blocked by autonomy gate — score < 70',
          );
          try {
            await this.bus.publish('dispatch', createAutonomySendBlocked({
              channel: request.channel,
              currentScore: autonomyConfig.score,
              requiredScore: 70,
            }));
          } catch (publishErr) {
            this.log.warn(
              { publishErr, channel: request.channel },
              'outbound-gateway: failed to publish autonomy.send_blocked event',
            );
          }
          return {
            success: false,
            blockedReason:
              `Autonomy score is ${autonomyConfig.score} — direct sends require a score of at least 70. ` +
              `Use createEmailDraft() for drafts, or ask the CEO to raise the score with set-autonomy.`,
          };
        }
      } catch (err) {
        // DB error — fail-open. Log at warn so anomalies are visible in alerting.
        this.log.warn(
          { err, channel: request.channel },
          'outbound-gateway: autonomy gate failed to read config — proceeding without gate (fail-open)',
        );
      }
    }
```

- [ ] **Step 5: Run all outbound gateway tests**

Run: `npx --prefix <worktree> vitest run tests/unit/skills/outbound-gateway.test.ts`
Expected: all tests pass, including the new autonomy gate tests.

- [ ] **Step 6: Run typecheck**

Run: `npx --prefix <worktree> tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```
feat: add autonomy gate to OutboundGateway.send()

Blocks all outbound sends when score < 70. Emits autonomy.send_blocked
on the bus. Fail-open when service is absent. createEmailDraft() is
unaffected — drafts are the intended fallback at lower autonomy levels.

Closes the outbound-gateway portion of #147.
```

---

### Task 7: Wiring — Pass AutonomyService to OutboundGateway

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add `autonomyService` to OutboundGateway construction**

In `src/index.ts`, find the `OutboundGateway` construction block (around line 642). Add `autonomyService` to the config object:

```ts
    outboundGateway = new OutboundGateway({
      nylasClients: nylasClientMap.size > 0 ? nylasClientMap : undefined,
      signalClient: signalRpcClient,
      signalPhoneNumber: config.signalPhoneNumber,
      contactService,
      contentFilter: outboundFilter,
      bus,
      ceoEmail: config.ceoPrimaryEmail || undefined,
      logger,
      autonomyService,  // ← add this line
    });
```

`autonomyService` is already declared in `src/index.ts` (used by the execution layer). No new variable needed.

- [ ] **Step 2: Run typecheck**

Run: `npx --prefix <worktree> tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```
feat: wire autonomyService into OutboundGateway

Passes the existing AutonomyService instance to OutboundGateway so
the score < 70 gate has access to the live autonomy config.
```

---

### Task 8: Run Full Test Suite

- [ ] **Step 1: Run the full test suite**

Run: `npx --prefix <worktree> vitest run`
Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run: `npx --prefix <worktree> tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Fix any regressions**

If any existing tests fail, fix the root cause before proceeding. Common issues:
- Tests constructing `ExecutionLayer` with a manifest missing `action_risk` (none exist — checked)
- Tests constructing `OutboundGateway` without the new optional `autonomyService` field (will be undefined — fail-open, so should pass)

---

### Task 9: Documentation Updates

**Files:**
- Modify: `docs/dev/adding-a-skill.md`
- Modify: `docs/specs/14-autonomy-engine.md`
- Modify: `docs/specs/03-skills-and-execution.md`
- Modify: `CLAUDE.md`
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Update `docs/dev/adding-a-skill.md`**

At line 96, change:
```
All skills must declare this field — manifests without it will be rejected at startup once Phase 2 gating is wired, and it is required now so skills are correctly labeled when that goes live.
```
to:
```
All skills must declare this field — manifests without it are rejected at startup. The execution layer enforces this against the live autonomy score: if the score is below the skill's action_risk threshold, the invocation returns an advisory failure.
```

At line 108, change:
```
**Phase 1 status:** `action_risk` is declared and validated at load time but not yet enforced at runtime — the hard gate is Phase 2 work.
```
to:
```
**Status:** `action_risk` is validated at load time and enforced at runtime. Skills whose action_risk exceeds the current autonomy score are blocked with an advisory failure.
```

At line 110, change:
```
**How Phase 2 gating will work:** When an agent calls a skill, the execution layer compares the skill's minimum required autonomy score against the live global score from `autonomy_config`. If the score is too low, the invocation returns an advisory failure (no throw, same `{ success: false, error }` shape as any other failure) and an audit event is emitted. The autonomy score is CEO-controlled via the `set-autonomy` skill. See `docs/specs/14-autonomy-engine.md` for the full spec.
```
to:
```
**How gating works:** When an agent calls a skill, the execution layer compares the skill's minimum required autonomy score against the live global score from `autonomy_config`. If the score is too low, the invocation returns an advisory failure (no throw, same `{ success: false, error }` shape as any other failure) and an `autonomy.skill_blocked` audit event is emitted. The autonomy score is CEO-controlled via the `set-autonomy` skill. See `docs/specs/14-autonomy-engine.md` for the full spec.
```

At line 481, change:
```
- [Autonomy Engine](../specs/14-autonomy-engine.md) — how `action_risk` gates execution (Phase 2 hard gates, Phase 3 auto-adjustment)
```
to:
```
- [Autonomy Engine](../specs/14-autonomy-engine.md) — how `action_risk` gates execution (hard gates, Phase 3 auto-adjustment)
```

- [ ] **Step 2: Update `docs/specs/14-autonomy-engine.md`**

At line 12, change:
```
**Phase 2 (future):** Hard execution gates — skill invocations blocked when score is below the skill's declared `action_risk` floor.
```
to:
```
**Phase 2 (implemented):** Hard execution gates — skill invocations blocked when score is below the skill's declared `action_risk` floor.
```

At line 179, change:
```
**This field is required in all skill manifests.** Phase 1 validates presence at load time. Phase 2 will enforce it at runtime by blocking skill execution when the live score is below the skill's floor.
```
to:
```
**This field is required in all skill manifests.** Validated at load time (startup rejects missing fields). Enforced at runtime: the execution layer blocks skill invocations when the live score is below the skill's floor.
```

At line 203, change:
```
## Phase 2: Hard Execution Gates (Future)
```
to:
```
## Phase 2: Hard Execution Gates (Implemented)
```

Update the status table rows (around lines 226-228):
```
| Phase 2: hard execution gates (block skill when score < `action_risk` floor) | Done |
| Phase 2: `OutboundGateway` autonomy check (score < 70 → block direct send) | Done |
```

- [ ] **Step 3: Update `docs/specs/03-skills-and-execution.md`**

Find the `action_risk` reference in the skill manifest section and ensure it says "required" and "enforced at runtime." If it already says "required on all manifests," add: "Enforced by the execution layer against the live autonomy score."

- [ ] **Step 4: Update `CLAUDE.md`**

In the "Autonomy Awareness" section, change:
```
This field is **required** — Phase 2 will reject manifests that omit it at startup:
```
to:
```
This field is **required** — manifests that omit it are rejected at startup, and the execution layer enforces it against the live autonomy score:
```

- [ ] **Step 5: Update `CONTRIBUTING.md`**

In the "Adding a New Skill" section, ensure `action_risk` is listed as a required field. If it references Phase 2 as future, update the language.

- [ ] **Step 6: Commit**

```
docs: update Phase 2 references to reflect implemented status

Updates adding-a-skill.md, 14-autonomy-engine.md, 03-skills-and-execution.md,
CLAUDE.md, and CONTRIBUTING.md to reflect that action_risk enforcement
is now live, not future work.
```

---

### Task 10: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entries under `## [Unreleased]`**

Add under the appropriate sections:

```markdown
### Added

- **Autonomy hard gates (spec 14, Phase 2):** execution layer blocks skill invocations when the live autonomy score is below the skill's declared `action_risk` threshold. Full restriction (score < 60) blocks all non-read skills. `OutboundGateway.send()` independently blocks direct sends when score < 70 — drafts remain available as the intended fallback. Both gates emit audit events (`autonomy.skill_blocked`, `autonomy.send_blocked`) and return advisory failures that surface the required score to the agent.

### Changed

- **`action_risk` enforcement:** `SkillRegistry.register()` now throws at startup if a skill manifest is missing the `action_risk` field (previously accepted silently).
```

- [ ] **Step 2: Commit**

```
chore: add CHANGELOG entries for autonomy hard gates
```

---

### Task 11: Final Verification

- [ ] **Step 1: Run the full test suite one final time**

Run: `npx --prefix <worktree> vitest run`
Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run: `npx --prefix <worktree> tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Review all changes**

Run: `git -C <worktree> diff main --stat`
Verify only the expected files were changed. No stray modifications.
