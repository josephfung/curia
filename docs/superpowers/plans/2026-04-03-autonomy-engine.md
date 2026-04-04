# Autonomy Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a global autonomy score (0–100) for the Nathan Curia instance — stored in Postgres, adjustable by the CEO via two CLI skills, and injected into the coordinator's system prompt on every task so Nathan self-governs accordingly.

**Architecture:** New `AutonomyService` in `src/autonomy/` owns all DB access and the band→description map. `AgentRuntime` reads it per-task and appends the autonomy block to the effective system prompt. `ExecutionLayer` passes it through `SkillContext` so the two new skills (`get-autonomy`, `set-autonomy`) can read and write the score. `set-autonomy` is elevated (CEO-only via the existing CallerContext gate).

**Tech Stack:** TypeScript/ESM, Node 22+, PostgreSQL (node-postgres pool), Vitest, node-pg-migrate (plain SQL migrations). No new dependencies required.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/db/migrations/011_create_autonomy.sql` | Schema for `autonomy_config` + `autonomy_history`; seeds default row |
| Create | `src/autonomy/autonomy-service.ts` | DB reads/writes, band logic, prompt block formatting |
| Create | `tests/unit/autonomy/autonomy-service.test.ts` | Unit tests for `AutonomyService` |
| Modify | `src/skills/types.ts` | Add `autonomyService?: AutonomyService` to `SkillContext` |
| Modify | `src/skills/execution.ts` | Accept + store + inject `autonomyService` in options/context |
| Modify | `src/agents/runtime.ts` | Add `autonomyService?` to `AgentConfig`; inject per-task in `processTask()` |
| Modify | `src/index.ts` | Instantiate `AutonomyService`; wire into `ExecutionLayer` and coordinator `AgentRuntime` |
| Create | `skills/get-autonomy/skill.json` | Skill manifest |
| Create | `skills/get-autonomy/handler.ts` | Read score + recent history, return human-readable summary |
| Create | `skills/set-autonomy/skill.json` | Skill manifest (elevated, infrastructure) |
| Create | `skills/set-autonomy/handler.ts` | Validate score, upsert config, append history |
| Modify | `agents/coordinator.yaml` | Pin `get-autonomy` and `set-autonomy` |
| Modify | `README.md` | Add Autonomy Engine section + spec 12 row in Project Status |
| Modify | `CLAUDE.md` | Add Autonomy Awareness checklist to "Adding Things" |

---

## Task 1: Database Migration

**Files:**
- Create: `src/db/migrations/011_create_autonomy.sql`

- [ ] **Step 1.1: Write the migration**

```sql
-- Up Migration

-- Single-row table holding the live autonomy score.
-- The CONSTRAINT single_row CHECK (id = 1) ensures exactly one row exists —
-- enforced at the DB level rather than application code.
CREATE TABLE autonomy_config (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  score       INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  band        TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL,
  CONSTRAINT single_row CHECK (id = 1)
);

-- Append-only audit trail — never updated or deleted.
-- Phase 2 auto-adjustment will also write here (changed_by = 'system').
CREATE TABLE autonomy_history (
  id             BIGSERIAL PRIMARY KEY,
  score          INTEGER NOT NULL,
  previous_score INTEGER,
  band           TEXT NOT NULL,
  changed_by     TEXT NOT NULL,
  reason         TEXT,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the default starting score (75 = approval-required).
-- ON CONFLICT DO NOTHING makes this idempotent on existing deployments.
INSERT INTO autonomy_config (id, score, band, updated_by)
VALUES (1, 75, 'approval-required', 'system')
ON CONFLICT (id) DO NOTHING;

-- Seed the corresponding history entry so the audit trail starts complete.
INSERT INTO autonomy_history (score, previous_score, band, changed_by, reason)
VALUES (75, NULL, 'approval-required', 'system', 'Initial default score');
```

- [ ] **Step 1.2: Verify migration runs cleanly**

```bash
cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-engine
pnpm local
```

Expected: Startup log shows `"Database migrations applied" count=1 migrations=["011_create_autonomy"]`. Then Ctrl+C.

- [ ] **Step 1.3: Commit**

```bash
git add src/db/migrations/011_create_autonomy.sql
git commit -m "feat: add autonomy_config and autonomy_history tables (migration 011)"
```

---

## Task 2: AutonomyService

**Files:**
- Create: `src/autonomy/autonomy-service.ts`

- [ ] **Step 2.1: Write the service**

```typescript
// autonomy-service.ts — manages the global autonomy score for the Curia instance.
//
// The autonomy score (0–100) determines how independently Nathan operates.
// It maps to one of five bands, each with a behavioral description that is
// injected into the coordinator's system prompt on every task.
//
// Phase 1: CEO-controlled via get-autonomy / set-autonomy skills.
// Phase 2: Automatic adjustment based on action log data (future).

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';

export type AutonomyBand =
  | 'full'
  | 'spot-check'
  | 'approval-required'
  | 'draft-only'
  | 'restricted';

export interface AutonomyConfig {
  score: number;
  band: AutonomyBand;
  updatedAt: Date;
  updatedBy: string;
}

export interface AutonomyHistoryEntry {
  id: number;
  score: number;
  previousScore: number | null;
  band: AutonomyBand;
  changedBy: string;
  reason: string | null;
  changedAt: Date;
}

// Static map of band labels to their behavioral descriptions.
// These are injected verbatim into the coordinator system prompt.
const BAND_DESCRIPTIONS: Record<AutonomyBand, string> = {
  'full':
    'Act independently. No confirmation needed for standard operations. Flag only genuinely ' +
    'novel, irreversible, or high-stakes actions — where the downside of acting without ' +
    'checking outweighs the cost of the pause.',
  'spot-check':
    'Proceed on routine tasks. For consequential actions — sending external communications, ' +
    'creating commitments, or acting on behalf of the CEO — note what you are doing in your ' +
    'response so the CEO maintains visibility. No need to stop and ask.',
  'approval-required':
    'For any consequential action, present your plan and explicitly ask for confirmation ' +
    'before proceeding. Routine reporting, summarization, and information retrieval can ' +
    'proceed without approval. When in doubt, draft and ask.',
  'draft-only':
    'Prepare drafts, plans, and analysis, but do not send, publish, schedule, or act on ' +
    'behalf of the CEO without an explicit instruction to do so. Surface your work for review; ' +
    'execution requires a direct go-ahead.',
  'restricted':
    'Present options and analysis only. Take no independent action. All outputs are advisory. ' +
    'Every step that would have an external effect requires explicit CEO instruction.',
};

// Human-readable band labels for display.
const BAND_LABELS: Record<AutonomyBand, string> = {
  'full': 'Full',
  'spot-check': 'Spot-check',
  'approval-required': 'Approval Required',
  'draft-only': 'Draft Only',
  'restricted': 'Restricted',
};

export class AutonomyService {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  /** Derive the autonomy band from a numeric score. */
  static bandForScore(score: number): AutonomyBand {
    if (score >= 90) return 'full';
    if (score >= 80) return 'spot-check';
    if (score >= 70) return 'approval-required';
    if (score >= 60) return 'draft-only';
    return 'restricted';
  }

  /** Return the behavioral description for a band. */
  static bandDescription(band: AutonomyBand): string {
    return BAND_DESCRIPTIONS[band];
  }

  /**
   * Format the autonomy block for injection into the coordinator system prompt.
   * Returns a Markdown section with the current score, band label, and behavioral guidance.
   */
  static formatPromptBlock(config: AutonomyConfig): string {
    const label = BAND_LABELS[config.band];
    const description = BAND_DESCRIPTIONS[config.band];
    return [
      '## Autonomy Level',
      '',
      `Your current autonomy score is ${config.score} (${label}).`,
      '',
      description,
    ].join('\n');
  }

  /** Read the current autonomy config. Returns null if the row does not exist (pre-migration). */
  async getConfig(): Promise<AutonomyConfig | null> {
    try {
      const result = await this.pool.query<{
        score: number;
        band: string;
        updated_at: Date;
        updated_by: string;
      }>('SELECT score, band, updated_at, updated_by FROM autonomy_config WHERE id = 1');

      if (result.rows.length === 0) return null;

      const row = result.rows[0]!;
      return {
        score: row.score,
        band: row.band as AutonomyBand,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      };
    } catch (err) {
      // Log but don't throw — a missing table (pre-migration) should degrade gracefully.
      // The coordinator will just run without the autonomy block until the migration runs.
      this.logger.warn({ err }, 'autonomy-service: failed to read autonomy_config — is migration 011 applied?');
      return null;
    }
  }

  /**
   * Update the autonomy score. Upserts autonomy_config and appends to autonomy_history.
   * Throws if score is out of range [0, 100].
   */
  async setScore(score: number, changedBy: string, reason?: string): Promise<AutonomyConfig> {
    if (!Number.isInteger(score) || score < 0 || score > 100) {
      throw new Error(`Invalid autonomy score: ${score}. Must be an integer between 0 and 100.`);
    }

    const band = AutonomyService.bandForScore(score);

    // Read the current score before updating so history has previous_score.
    const current = await this.getConfig();
    const previousScore = current?.score ?? null;

    // Upsert the live config row.
    await this.pool.query(
      `INSERT INTO autonomy_config (id, score, band, updated_at, updated_by)
       VALUES (1, $1, $2, now(), $3)
       ON CONFLICT (id) DO UPDATE SET score = $1, band = $2, updated_at = now(), updated_by = $3`,
      [score, band, changedBy],
    );

    // Append to the append-only audit trail.
    await this.pool.query(
      `INSERT INTO autonomy_history (score, previous_score, band, changed_by, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [score, previousScore, band, changedBy, reason ?? null],
    );

    this.logger.info({ score, band, changedBy, previousScore }, 'Autonomy score updated');

    return { score, band, updatedAt: new Date(), updatedBy: changedBy };
  }

  /** Return the most recent history entries, newest first. */
  async getHistory(limit = 3): Promise<AutonomyHistoryEntry[]> {
    const result = await this.pool.query<{
      id: number;
      score: number;
      previous_score: number | null;
      band: string;
      changed_by: string;
      reason: string | null;
      changed_at: Date;
    }>(
      'SELECT id, score, previous_score, band, changed_by, reason, changed_at FROM autonomy_history ORDER BY changed_at DESC LIMIT $1',
      [limit],
    );

    return result.rows.map(row => ({
      id: row.id,
      score: row.score,
      previousScore: row.previous_score,
      band: row.band as AutonomyBand,
      changedBy: row.changed_by,
      reason: row.reason,
      changedAt: row.changed_at,
    }));
  }
}
```

- [ ] **Step 2.2: Commit**

```bash
git add src/autonomy/autonomy-service.ts
git commit -m "feat: AutonomyService — score storage, band logic, prompt block formatting"
```

---

## Task 3: Unit Tests for AutonomyService

**Files:**
- Create: `tests/unit/autonomy/autonomy-service.test.ts`

- [ ] **Step 3.1: Write the failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import type { AutonomyBand } from '../../../src/autonomy/autonomy-service.js';

function mockPool() {
  return { query: vi.fn() };
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

describe('AutonomyService', () => {
  // -- Static helpers --

  describe('bandForScore', () => {
    const cases: Array<[number, AutonomyBand]> = [
      [100, 'full'],
      [90, 'full'],
      [89, 'spot-check'],
      [80, 'spot-check'],
      [79, 'approval-required'],
      [70, 'approval-required'],
      [69, 'draft-only'],
      [60, 'draft-only'],
      [59, 'restricted'],
      [0, 'restricted'],
    ];

    it.each(cases)('score %i → band "%s"', (score, expected) => {
      expect(AutonomyService.bandForScore(score)).toBe(expected);
    });
  });

  describe('formatPromptBlock', () => {
    it('includes score, band label, and description', () => {
      const config = {
        score: 75,
        band: 'approval-required' as AutonomyBand,
        updatedAt: new Date(),
        updatedBy: 'ceo',
      };
      const block = AutonomyService.formatPromptBlock(config);
      expect(block).toContain('## Autonomy Level');
      expect(block).toContain('75');
      expect(block).toContain('Approval Required');
      // Should contain behavioral guidance for this band
      expect(block).toContain('present your plan');
    });

    it('produces different text for different bands', () => {
      const make = (score: number, band: AutonomyBand) =>
        AutonomyService.formatPromptBlock({ score, band, updatedAt: new Date(), updatedBy: 'ceo' });
      expect(make(95, 'full')).not.toBe(make(75, 'approval-required'));
    });
  });

  // -- getConfig --

  describe('getConfig', () => {
    let pool: ReturnType<typeof mockPool>;
    let logger: ReturnType<typeof mockLogger>;
    let svc: AutonomyService;

    beforeEach(() => {
      pool = mockPool();
      logger = mockLogger();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc = new AutonomyService(pool as any, logger as any);
    });

    it('returns the current config when a row exists', async () => {
      const now = new Date();
      pool.query.mockResolvedValueOnce({
        rows: [{ score: 75, band: 'approval-required', updated_at: now, updated_by: 'ceo' }],
      });

      const config = await svc.getConfig();
      expect(config).toEqual({ score: 75, band: 'approval-required', updatedAt: now, updatedBy: 'ceo' });
    });

    it('returns null when no row exists', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      expect(await svc.getConfig()).toBeNull();
    });

    it('returns null (not throw) when the DB call fails', async () => {
      pool.query.mockRejectedValueOnce(new Error('relation does not exist'));
      expect(await svc.getConfig()).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // -- setScore --

  describe('setScore', () => {
    let pool: ReturnType<typeof mockPool>;
    let svc: AutonomyService;

    beforeEach(() => {
      pool = mockPool();
      const logger = mockLogger();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc = new AutonomyService(pool as any, logger as any);
    });

    it('throws for out-of-range scores', async () => {
      await expect(svc.setScore(-1, 'ceo')).rejects.toThrow('Invalid autonomy score');
      await expect(svc.setScore(101, 'ceo')).rejects.toThrow('Invalid autonomy score');
    });

    it('throws for non-integer scores', async () => {
      await expect(svc.setScore(75.5, 'ceo')).rejects.toThrow('Invalid autonomy score');
    });

    it('upserts config and inserts history, then returns new config', async () => {
      // getConfig() call (to read previous_score)
      pool.query.mockResolvedValueOnce({ rows: [{ score: 70, band: 'approval-required', updated_at: new Date(), updated_by: 'ceo' }] });
      // upsert autonomy_config
      pool.query.mockResolvedValueOnce({ rows: [] });
      // insert autonomy_history
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await svc.setScore(80, 'ceo', 'good week');
      expect(result.score).toBe(80);
      expect(result.band).toBe('spot-check');
      expect(result.updatedBy).toBe('ceo');

      // upsert call
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO autonomy_config'),
        [80, 'spot-check', 'ceo'],
      );
      // history call — includes previous_score and reason
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO autonomy_history'),
        [80, 70, 'spot-check', 'ceo', 'good week'],
      );
    });

    it('passes null previous_score on first write (no existing config)', async () => {
      // getConfig returns null (no row yet)
      pool.query.mockResolvedValueOnce({ rows: [] });
      pool.query.mockResolvedValueOnce({ rows: [] }); // upsert
      pool.query.mockResolvedValueOnce({ rows: [] }); // history

      await svc.setScore(75, 'system');
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO autonomy_history'),
        [75, null, 'approval-required', 'system', null],
      );
    });
  });
});
```

- [ ] **Step 3.2: Run tests — expect failures**

```bash
cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-engine
pnpm test tests/unit/autonomy/autonomy-service.test.ts
```

Expected: FAIL — `Cannot find module '../../../src/autonomy/autonomy-service.js'`

- [ ] **Step 3.3: Run tests again now that Task 2 is complete**

```bash
pnpm test tests/unit/autonomy/autonomy-service.test.ts
```

Expected: All tests PASS.

- [ ] **Step 3.4: Commit**

```bash
git add tests/unit/autonomy/autonomy-service.test.ts
git commit -m "test: AutonomyService unit tests — band logic, getConfig, setScore"
```

---

## Task 4: Extend SkillContext

**Files:**
- Modify: `src/skills/types.ts`

- [ ] **Step 4.1: Add `autonomyService` to `SkillContext`**

In `src/skills/types.ts`, add after the `agentContactId` field (the last field before the closing brace):

```typescript
  /** Autonomy service — available to infrastructure skills that manage the global
   *  autonomy score (get-autonomy, set-autonomy). Not available to normal skills. */
  autonomyService?: import('../autonomy/autonomy-service.js').AutonomyService;
```

- [ ] **Step 4.2: Run typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4.3: Commit**

```bash
git add src/skills/types.ts
git commit -m "feat: add autonomyService to SkillContext"
```

---

## Task 5: Extend ExecutionLayer

**Files:**
- Modify: `src/skills/execution.ts`

- [ ] **Step 5.1: Add the import at the top of the imports block**

After the last `import type` line (currently `import type { EntityContextAssembler } ...`), add:

```typescript
import type { AutonomyService } from '../autonomy/autonomy-service.js';
```

- [ ] **Step 5.2: Add the private field**

After `private agentContactId?: string;` (line ~52), add:

```typescript
  private autonomyService?: AutonomyService;
```

- [ ] **Step 5.3: Add to the constructor options interface and assignment**

In the constructor options object (the parameter type after `options?: {`), add after `agentContactId?: string;`:

```typescript
    autonomyService?: AutonomyService;
```

In the constructor body, after `this.agentContactId = options?.agentContactId;`, add:

```typescript
    this.autonomyService = options?.autonomyService;
```

- [ ] **Step 5.4: Pass through in `invoke()`**

Find where `SkillContext` is assembled inside `invoke()` (the object passed to `skill.handler.execute(ctx)`). Add `autonomyService: this.autonomyService` alongside the other optional services such as `schedulerService` and `entityMemory`.

- [ ] **Step 5.5: Run typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 5.6: Commit**

```bash
git add src/skills/execution.ts
git commit -m "feat: thread autonomyService through ExecutionLayer into SkillContext"
```

---

## Task 6: Per-Task Prompt Injection in AgentRuntime

**Files:**
- Modify: `src/agents/runtime.ts`

- [ ] **Step 6.1: Add import**

At the top of `src/agents/runtime.ts`, after the existing imports, add:

```typescript
// Value import (not type-only) — we call AutonomyService.formatPromptBlock() as a static method.
import { AutonomyService } from '../autonomy/autonomy-service.js';
```

- [ ] **Step 6.2: Add `autonomyService` to `AgentConfig`**

In the `AgentConfig` interface, after `skillToolDefs?: ToolDefinition[];`, add:

```typescript
  /** Optional autonomy service — when provided, the autonomy block is injected
   *  into the effective system prompt on every task. Only the coordinator receives this. */
  autonomyService?: AutonomyService;
```

- [ ] **Step 6.3: Inject the autonomy block in `processTask()`**

In `processTask()`, find this line near the top of the method:

```typescript
const { agentId, systemPrompt, provider, bus, logger, memory, executionLayer, skillToolDefs } = this.config;
```

Replace it with:

```typescript
const { agentId, systemPrompt, provider, bus, logger, memory, executionLayer, skillToolDefs, autonomyService } = this.config;
```

Then, immediately after that destructure line and before `const budget = ...`, add:

```typescript
    // Load the current autonomy config and append its behavioral block to the
    // system prompt. This runs per-task (not at startup) so a CEO score change
    // mid-session takes effect on Nathan's next action without a restart.
    let effectiveSystemPrompt = systemPrompt;
    if (autonomyService) {
      const autonomyConfig = await autonomyService.getConfig();
      if (autonomyConfig) {
        effectiveSystemPrompt = systemPrompt + '\n\n' + AutonomyService.formatPromptBlock(autonomyConfig);
      }
    }
```

Then update the `messages` array construction to use `effectiveSystemPrompt` instead of `systemPrompt`:

```typescript
    const messages: Message[] = [
      { role: 'system', content: effectiveSystemPrompt },
      ...history,
      { role: 'user', content },
    ];
```

- [ ] **Step 6.4: Write a test for the injection**

In `tests/unit/agents/runtime.test.ts`, add a new test after the existing tests (inside the `describe('AgentRuntime', ...)` block):

```typescript
  it('appends the autonomy block to the system prompt when autonomyService is provided', async () => {
    const mockAutonomyService = {
      getConfig: vi.fn().mockResolvedValue({
        score: 75,
        band: 'approval-required',
        updatedAt: new Date(),
        updatedBy: 'system',
      }),
    };

    const provider = createMockProvider('OK');
    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'Base prompt.',
      provider,
      bus,
      logger: createLogger('error'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      autonomyService: mockAutonomyService as any,
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-auto-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-auto-1',
    });
    await bus.publish('dispatch', task);

    expect(mockAutonomyService.getConfig).toHaveBeenCalledOnce();
    // The system message sent to the LLM should contain both the base prompt and the autonomy block
    expect(provider.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Base prompt.'),
          }),
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Autonomy Level'),
          }),
        ]),
      }),
    );
  });

  it('uses base system prompt unchanged when autonomyService returns null', async () => {
    const mockAutonomyService = {
      getConfig: vi.fn().mockResolvedValue(null),
    };

    const provider = createMockProvider('OK');
    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'Base prompt.',
      provider,
      bus,
      logger: createLogger('error'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      autonomyService: mockAutonomyService as any,
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-auto-2',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-auto-2',
    });
    await bus.publish('dispatch', task);

    expect(provider.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'Base prompt.' },
          { role: 'user', content: 'Hello' },
        ],
      }),
    );
  });
```

- [ ] **Step 6.5: Run the new tests**

```bash
pnpm test tests/unit/agents/runtime.test.ts
```

Expected: all tests PASS (including the two new ones).

- [ ] **Step 6.6: Commit**

```bash
git add src/agents/runtime.ts tests/unit/agents/runtime.test.ts
git commit -m "feat: inject autonomy prompt block per-task in AgentRuntime"
```

---

## Task 7: Wire into index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 7.1: Add the import**

After the `import { bootstrapCeoContact }` line, add:

```typescript
import { AutonomyService } from './autonomy/autonomy-service.js';
```

- [ ] **Step 7.2: Instantiate AutonomyService after the pool is confirmed healthy**

After the line `logger.info('Database connected');` (inside the try block that verifies connectivity), add immediately after:

```typescript
  // Autonomy service — manages the global autonomy score (0–100).
  // Instantiated early (right after DB connect) so it's ready before agents start.
  const autonomyService = new AutonomyService(pool, logger);
```

- [ ] **Step 7.3: Pass autonomyService to ExecutionLayer**

Find the `ExecutionLayer` construction line (long options object). Add `autonomyService` to the options:

```typescript
  const executionLayer = new ExecutionLayer(skillRegistry, logger, {
    bus, agentRegistry, contactService, outboundGateway, heldMessages,
    schedulerService, entityMemory, agentPersona, nylasCalendarClient,
    entityContextAssembler, agentContactId: agentIdentityContactId,
    autonomyService,  // <-- add this
  });
```

- [ ] **Step 7.4: Pass autonomyService to the coordinator AgentRuntime**

In Pass 2 of agent registration, find the block that creates the `AgentRuntime`:

```typescript
    const agent = new AgentRuntime({
      agentId: agentConfig.name,
      systemPrompt,
      provider: llmProvider,
      bus,
      logger,
      memory,
      entityMemory,
      executionLayer,
      pinnedSkills: agentPinnedSkills,
      skillToolDefs: agentToolDefs,
      errorBudget: ...
    });
```

Add `autonomyService` conditionally — only the coordinator gets per-task injection:

```typescript
    const agent = new AgentRuntime({
      agentId: agentConfig.name,
      systemPrompt,
      provider: llmProvider,
      bus,
      logger,
      memory,
      entityMemory,
      executionLayer,
      pinnedSkills: agentPinnedSkills,
      skillToolDefs: agentToolDefs,
      // Only the coordinator receives the autonomy service — it's the only agent
      // that needs per-task autonomy prompt injection and the autonomy skills.
      autonomyService: agentConfig.role === 'coordinator' ? autonomyService : undefined,
      errorBudget: agentConfig.error_budget ? {
        maxTurns: agentConfig.error_budget.max_turns ?? DEFAULT_ERROR_BUDGET.maxTurns,
        maxConsecutiveErrors: agentConfig.error_budget.max_errors ?? DEFAULT_ERROR_BUDGET.maxConsecutiveErrors,
      } : undefined,
    });
```

- [ ] **Step 7.5: Run typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 7.6: Smoke test — confirm startup and autonomy block appears**

```bash
pnpm local
```

Type: `what is your current autonomy level?`

Expected: Nathan describes his score and band (he'll have the autonomy block in context even without the skill, since the prompt injection is now active). Then Ctrl+C.

- [ ] **Step 7.7: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire AutonomyService into ExecutionLayer and coordinator AgentRuntime"
```

---

## Task 8: `get-autonomy` Skill

**Files:**
- Create: `skills/get-autonomy/skill.json`
- Create: `skills/get-autonomy/handler.ts`

- [ ] **Step 8.1: Write the manifest**

```json
{
  "name": "get-autonomy",
  "description": "Report Nathan's current global autonomy score, band, and recent change history. Use this when the CEO asks about autonomy level, trust level, or how independently Nathan is operating.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {},
  "outputs": { "score": "number", "band": "string", "summary": "string" },
  "permissions": [],
  "secrets": [],
  "timeout": 10000,
  "autonomy_floor": "full"
}
```

- [ ] **Step 8.2: Write the handler**

```typescript
// handler.ts — get-autonomy skill.
//
// Reports the current global autonomy score and band to the CEO.
// Includes the last 3 history entries so the CEO can see recent changes.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class GetAutonomyHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.autonomyService) {
      return { success: false, error: 'get-autonomy requires autonomyService in context. Is infrastructure: true set in the manifest?' };
    }

    try {
      const [config, history] = await Promise.all([
        ctx.autonomyService.getConfig(),
        ctx.autonomyService.getHistory(3),
      ]);

      if (!config) {
        return { success: false, error: 'Autonomy config not found — migration 011 may not have run.' };
      }

      // Format the band label for human display
      const bandLabels: Record<string, string> = {
        'full': 'Full',
        'spot-check': 'Spot-check',
        'approval-required': 'Approval Required',
        'draft-only': 'Draft Only',
        'restricted': 'Restricted',
      };
      const bandLabel = bandLabels[config.band] ?? config.band;

      // Build a readable summary
      const lines: string[] = [
        `Autonomy score: ${config.score} — ${bandLabel}`,
        `Last updated: ${config.updatedAt.toISOString().split('T')[0]} by ${config.updatedBy}`,
      ];

      if (history.length > 0) {
        lines.push('', 'Recent changes:');
        for (const entry of history) {
          const date = entry.changedAt.toISOString().split('T')[0] ?? '';
          const prev = entry.previousScore !== null ? `${entry.previousScore} → ` : '';
          const reason = entry.reason ? `  "${entry.reason}"` : '';
          lines.push(`  ${date}  ${prev}${entry.score} (${entry.band})${reason}  — ${entry.changedBy}`);
        }
      }

      return {
        success: true,
        data: {
          score: config.score,
          band: config.band,
          summary: lines.join('\n'),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'get-autonomy failed');
      return { success: false, error: message };
    }
  }
}
```

- [ ] **Step 8.3: Run typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 8.4: Commit**

```bash
git add skills/get-autonomy/
git commit -m "feat: get-autonomy skill — report current score, band, and history"
```

---

## Task 9: `set-autonomy` Skill

**Files:**
- Create: `skills/set-autonomy/skill.json`
- Create: `skills/set-autonomy/handler.ts`

- [ ] **Step 9.1: Write the manifest**

```json
{
  "name": "set-autonomy",
  "description": "Update Nathan's global autonomy score (0–100). Requires CEO authorization. Lower scores require more approvals before Nathan acts; higher scores allow more independent action. Optionally provide a reason for the change.",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "infrastructure": true,
  "inputs": {
    "score": "number",
    "reason": "string?"
  },
  "outputs": { "score": "number", "band": "string", "previous_score": "number" },
  "permissions": [],
  "secrets": [],
  "timeout": 10000,
  "autonomy_floor": "full"
}
```

- [ ] **Step 9.2: Write the handler**

```typescript
// handler.ts — set-autonomy skill.
//
// Updates the global autonomy score. Elevated sensitivity — requires CEO CallerContext.
// Validated and rejected by the execution layer if the caller is not CEO.
// Upserts autonomy_config and appends to autonomy_history.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class SetAutonomyHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.autonomyService) {
      return { success: false, error: 'set-autonomy requires autonomyService in context. Is infrastructure: true set in the manifest?' };
    }

    const { score, reason } = ctx.input as { score?: unknown; reason?: unknown };

    // Validate score input — the LLM may pass a float or string
    const parsedScore = typeof score === 'number' ? score : Number(score);
    if (!Number.isFinite(parsedScore)) {
      return { success: false, error: `Invalid score: "${score}". Must be a number between 0 and 100.` };
    }

    // Round to nearest integer — tolerate minor float imprecision from the LLM
    const intScore = Math.round(parsedScore);

    const changedBy = ctx.caller?.role ?? ctx.caller?.contactId ?? 'ceo';
    const reasonStr = typeof reason === 'string' && reason.trim() ? reason.trim() : undefined;

    try {
      const previous = await ctx.autonomyService.getConfig();
      const previousScore = previous?.score ?? null;

      const updated = await ctx.autonomyService.setScore(intScore, changedBy, reasonStr);

      const bandLabels: Record<string, string> = {
        'full': 'Full',
        'spot-check': 'Spot-check',
        'approval-required': 'Approval Required',
        'draft-only': 'Draft Only',
        'restricted': 'Restricted',
      };
      const bandLabel = bandLabels[updated.band] ?? updated.band;

      const changeDesc = previousScore !== null
        ? `${previousScore} → ${updated.score}`
        : `${updated.score}`;

      return {
        success: true,
        data: {
          score: updated.score,
          band: updated.band,
          previous_score: previousScore,
          summary: `Autonomy score updated: ${changeDesc} (${bandLabel}).${reasonStr ? ` Reason: "${reasonStr}".` : ''}`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'set-autonomy failed');
      return { success: false, error: message };
    }
  }
}
```

- [ ] **Step 9.3: Run typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 9.4: Commit**

```bash
git add skills/set-autonomy/
git commit -m "feat: set-autonomy skill — CEO-only score update with history append"
```

---

## Task 10: Pin Skills to Coordinator

**Files:**
- Modify: `agents/coordinator.yaml`

- [ ] **Step 10.1: Add the two skills to `pinned_skills`**

At the end of the `pinned_skills` list (currently ending with `calendar-check-conflicts`), add:

```yaml
  - get-autonomy
  - set-autonomy
```

- [ ] **Step 10.2: Smoke test — confirm skills are available**

```bash
pnpm local
```

Type: `what is your current autonomy score?`

Expected: Nathan calls `get-autonomy` and reports the score (75, Approval Required) with history. Then Ctrl+C.

Type: `set my autonomy score to 80` (in a new session or continuation)

Expected: Nathan calls `set-autonomy` and confirms the update.

- [ ] **Step 10.3: Commit**

```bash
git add agents/coordinator.yaml
git commit -m "feat: pin get-autonomy and set-autonomy to coordinator"
```

---

## Task 11: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 11.1: Add a new "Autonomy Engine" section after the "Scheduling" section**

Find the line `---` immediately after the Scheduling section ends (before `## Multi-Provider LLM Support`). Insert the new section before it:

```markdown
## Autonomy Engine

Nathan operates at a configurable autonomy level — a single score from 0 to 100 that determines how independently he acts across all channels and skills.

The score maps to one of five **autonomy bands**:

| Band | Score | What it means |
|---|---|---|
| **Full** | 90–100 | Acts independently. Flags only genuinely novel or irreversible actions. |
| **Spot-check** | 80–89 | Proceeds on routine tasks. Notes consequential actions for CEO visibility. |
| **Approval Required** | 70–79 | Presents a plan and asks for confirmation before any consequential action. |
| **Draft Only** | 60–69 | Prepares drafts and plans but does not send or act without explicit instruction. |
| **Restricted** | < 60 | Advisory only. Takes no independent action whatsoever. |

The current band is injected into Nathan's system prompt on every task, so his self-governance adjusts immediately when the score changes — no restart required.

**CEO controls (via CLI or email):**
- *"What is your current autonomy score?"* — Nathan reports his score, band, and recent change history
- *"Set your autonomy score to 85"* — Nathan updates the score and confirms the change

The score defaults to **75 (Approval Required)** on first deployment. Scores are stored in Postgres with a full change history. Future versions will adjust the score automatically based on performance metrics (task success rate, factual correction rate, follow-through).

```

- [ ] **Step 11.2: Add spec 12 to the Project Status table**

Find the end of the Project Status table. Add a new row after the existing `—` rows (Outbound safety and Smoke test):

```markdown
| 12 | Autonomy engine (global score, CEO controls, per-task prompt injection) | Planned |
```

- [ ] **Step 11.3: Commit**

```bash
git add README.md
git commit -m "docs: add Autonomy Engine section and spec 12 to README"
```

---

## Task 12: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 12.1: Add the Autonomy Awareness checklist**

In `CLAUDE.md`, find the `### New Skill` section under `## Adding Things`. After that section's steps, add a new subsection:

```markdown
### Autonomy Awareness

When adding a new skill, declare its autonomy floor in `skill.json` (this field is not enforced in Phase 1 but is required for Phase 2 gate wiring):

```json
"autonomy_floor": "spot-check"
```

Floors by capability class:
- `"full"` — reads, retrieval, summarization (no external effect)
- `"spot-check"` — outbound communications, internal state writes
- `"approval-required"` — calendar writes, commitments on behalf of CEO
- `"draft-only"` — financial actions, high-stakes operations
- `"restricted"` — irreversible or destructive actions

When adding a new agent, ensure it receives the autonomy block via the runtime injection mechanism (same pattern as date/timezone injection — pass `autonomyService` in `AgentRuntime` config if the agent needs autonomy awareness). See `docs/specs/12-autonomy-engine.md`.
```

- [ ] **Step 12.2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add Autonomy Awareness checklist to CLAUDE.md"
```

---

## Task 13: Full Test Suite

- [ ] **Step 13.1: Run the full test suite**

```bash
cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-autonomy-engine
pnpm test
```

Expected: all existing tests plus the new autonomy tests pass. No regressions.

- [ ] **Step 13.2: Run typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 13.3: Final smoke test**

```bash
pnpm local
```

Run through the following sequence:
1. *"What is your current autonomy level?"* → Nathan calls `get-autonomy` and reports 75 / Approval Required
2. *"Set your autonomy score to 85 — you've been doing well."* → Nathan calls `set-autonomy`, confirms 75 → 85 / Spot-check
3. *"What is your autonomy score now?"* → Nathan reports 85 / Spot-check with history showing the change

Then Ctrl+C.
