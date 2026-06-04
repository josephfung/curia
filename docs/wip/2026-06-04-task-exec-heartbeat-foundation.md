# Task Execution & Heartbeat — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the platform machinery for autonomous task execution — a declarative `enable_task_management` agent capability and a deterministic hourly `BacklogHeartbeat` that wakes idle/stale tasks — with the coordinator enabled as the canary.

**Architecture:** A new boolean agent-YAML flag (`enable_task_management`) auto-pins the four `task-*` skills, injects a shared executor-discipline prompt block, and registers the agent as heartbeat-eligible. A new System-layer component (`BacklogHeartbeat`) runs on a `setInterval`, selects idle/stale tasks via one deterministic SQL query (one entry-point per effective owner agent, globally capped), and inserts one-shot `scheduled_jobs` wake rows that the **existing, unchanged** scheduler dispatches to each owning agent. Execution stays distributed to owners; the heartbeat only routes.

**Tech Stack:** TypeScript (ESM, Node 22+), PostgreSQL 16 (node-pg + plain-SQL migrations via node-pg-migrate), Vitest (unit + real-Postgres integration), pino logging.

**Scope:** This plan covers design §3 (heartbeat) + §6 (capability flag) + enabling the coordinator. It does **not** cover ceo-inbox (#840), meeting-debrief/research-analyst onboarding, or the stretch `last_advanced_at` column — those are a follow-up plan. Reference spec: [`docs/wip/2026-06-04-task-execution-heartbeat-design.md`](2026-06-04-task-execution-heartbeat-design.md).

**Conventions for every commit:** No `Co-Authored-By` / no Claude attribution (per repo CLAUDE.md). Run `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat run typecheck` before each commit touching `.ts`. Integration tests require `DATABASE_URL` pointing at an **empty test database** (they `DELETE` rows); they auto-skip when it is unset.

---

## File Structure

**New files:**
- `src/agents/task-management.ts` — single source of truth for the capability: the four skill names, the injected discipline block (design §6.1), and the pure `applyTaskManagement()` helper.
- `tests/unit/agents/task-management.test.ts` — unit tests for `applyTaskManagement()`.
- `src/scheduler/backlog-heartbeat.ts` — the `BacklogHeartbeat` System component (`start`/`stop`/`tick`).
- `tests/unit/scheduler/backlog-heartbeat.test.ts` — unit tests (mocked deps, fake timers).
- `tests/integration/backlog-heartbeat.test.ts` — real-Postgres end-to-end selection + enqueue.
- `tests/integration/heartbeat-selection.test.ts` — real-Postgres tests for the selection SQL.

**Modified files:**
- `src/agents/loader.ts` — add `enable_task_management?: boolean` to `AgentYamlConfig`.
- `src/index.ts` — apply `applyTaskManagement()` in the agent bootstrap loop; build the eligible-agents set; construct + start + stop `BacklogHeartbeat`.
- `src/db/queries/tasks.ts` — add `selectHeartbeatCandidates()`.
- `src/scheduler/scheduler-service.ts` — add `enqueueTaskWake()`.
- `src/config.ts` — add the `tasks` config section to `YamlConfig` + `resolveTasksConfig()`.
- `schemas/default-config.schema.json` — register the `tasks` object (root is `additionalProperties:false`).
- `config/default.yaml` — add the `tasks:` block.
- `tests/unit/config.test.ts` (or the existing config test file) — `resolveTasksConfig` defaults + parsing.
- `agents/coordinator.yaml` — set the flag, drop redundant manual pins, add `error_budget`, bump version.
- `CHANGELOG.md` — `[Unreleased]` entries.

---

## Part A — `enable_task_management` capability

### Task A1: Add the flag to the agent config type

**Files:**
- Modify: `src/agents/loader.ts` (interface `AgentYamlConfig`, after the `inject_specialists?: boolean;` field, ~line 67)

- [ ] **Step 1: Add the field**

In `src/agents/loader.ts`, inside `export interface AgentYamlConfig { … }`, immediately after the `inject_specialists?: boolean;` line, add:

```typescript
  /** When true, the runtime auto-pins the task-* skills, injects the shared
   *  task-management discipline block, and marks the agent heartbeat-eligible.
   *  See docs/wip/2026-06-04-task-execution-heartbeat-design.md §6. Default: false. */
  enable_task_management?: boolean;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat add src/agents/loader.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat commit -m "feat: add enable_task_management flag to AgentYamlConfig"
```

---

### Task A2: The capability module (block + skills + pure helper)

**Files:**
- Create: `src/agents/task-management.ts`
- Test: `tests/unit/agents/task-management.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agents/task-management.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  applyTaskManagement,
  TASK_MANAGEMENT_SKILLS,
  TASK_MANAGEMENT_BLOCK,
} from '../../../src/agents/task-management.js';
import type { AgentYamlConfig } from '../../../src/agents/loader.js';

function cfg(overrides: Partial<AgentYamlConfig> = {}): AgentYamlConfig {
  return {
    name: 'test-agent',
    model: { tier: 'standard' },
    system_prompt: 'BASE PROMPT',
    ...overrides,
  };
}

describe('applyTaskManagement', () => {
  it('is a no-op when the flag is absent', () => {
    const r = applyTaskManagement(cfg(), 'BASE PROMPT', ['a', 'b']);
    expect(r.systemPrompt).toBe('BASE PROMPT');
    expect(r.pinnedSkills).toEqual(['a', 'b']);
    expect(r.heartbeatEligible).toBe(false);
  });

  it('is a no-op when the flag is explicitly false', () => {
    const r = applyTaskManagement(cfg({ enable_task_management: false }), 'BASE PROMPT', []);
    expect(r.systemPrompt).toBe('BASE PROMPT');
    expect(r.pinnedSkills).toEqual([]);
    expect(r.heartbeatEligible).toBe(false);
  });

  it('appends the block, adds the four skills, and marks eligible when true', () => {
    const r = applyTaskManagement(cfg({ enable_task_management: true }), 'BASE PROMPT', ['x']);
    expect(r.systemPrompt).toBe(`BASE PROMPT\n\n${TASK_MANAGEMENT_BLOCK}`);
    expect(r.pinnedSkills).toEqual(['x', ...TASK_MANAGEMENT_SKILLS]);
    expect(r.heartbeatEligible).toBe(true);
  });

  it('does not duplicate skills already pinned', () => {
    const base = ['task-list', 'other'];
    const r = applyTaskManagement(cfg({ enable_task_management: true }), 'P', base);
    // task-list kept once, the other three appended
    expect(r.pinnedSkills.filter((s) => s === 'task-list')).toHaveLength(1);
    expect(r.pinnedSkills).toEqual(['task-list', 'other', 'task-create', 'task-update', 'task-complete']);
  });

  it('exposes exactly the four task skills', () => {
    expect([...TASK_MANAGEMENT_SKILLS]).toEqual(['task-create', 'task-list', 'task-update', 'task-complete']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/unit/agents/task-management.test.ts`
Expected: FAIL — cannot resolve `../../../src/agents/task-management.js`.

- [ ] **Step 3: Implement the module**

Create `src/agents/task-management.ts`:

```typescript
import type { AgentYamlConfig } from './loader.js';

/** The four skills every task-management-enabled agent can call. */
export const TASK_MANAGEMENT_SKILLS = [
  'task-create',
  'task-list',
  'task-update',
  'task-complete',
] as const;

/** Single source of truth for the executor-discipline block injected into every
 *  task-management-enabled agent's effective system prompt.
 *  See docs/wip/2026-06-04-task-execution-heartbeat-design.md §6.1. */
export const TASK_MANAGEMENT_BLOCK = [
  '## Task Management',
  '',
  'You can defer, track, and resume work using your task skills.',
  '',
  '**Decide, don\'t drop.** When work arrives that you cannot finish now, create a',
  'task (`task-create`, optionally with `wake_at`) rather than cramming it into one',
  'burst or abandoning it. Briefly tell the CEO what you queued and why.',
  '',
  '**Decompose projects.** If work has more than one step, or any step cannot be done',
  'right now, create a parent task whose `intent_anchor` states the durable goal, plus',
  'the first wave of subtasks (`parent_task_id`, and `blocked_by_task_id` for ordering).',
  'Plan the first wave only; add subtasks as you learn more.',
  '',
  '**Advance until blocked.** When you act on a task, do every step you can right now.',
  'Stop only at a real blocker — waiting on a person, on the CEO\'s approval, on a future',
  'date, or on a prior task — or when your turn budget runs low. Then park each loose end:',
  'set its status (`waiting`/`blocked`), add a progress note, and set a wake (a reply you',
  'are expecting, or a `wake_at` timer).',
  '',
  '**Never promise without a task.** Before you send anything that commits to a future',
  'action ("I\'ll follow up with X", "we\'ll send that over"), make sure a task backs that',
  'promise. Prefer to resolve the dependency first and send a complete message. Only send',
  'an interim "I\'ll follow up" when the recipient needs an acknowledgment now — and when',
  'you do, create the follow-up task (yours if you can chase it; the CEO\'s if only they',
  'can, and tell them).',
  '',
  '**Resuming.** When you are woken to advance a task, you receive its id, title, intent,',
  'and progress. Pick up where you left off. You may pull your other ready tasks',
  '(`task-list`) and advance them too, in dependency order, until blocked or budget-bound.',
].join('\n');

export interface TaskManagementResult {
  systemPrompt: string;
  pinnedSkills: string[];
  heartbeatEligible: boolean;
}

/** Apply the enable_task_management capability to an agent's prompt + skills.
 *  Pure function — no side effects. When the flag is off (default), returns the
 *  inputs unchanged and heartbeatEligible=false. */
export function applyTaskManagement(
  config: AgentYamlConfig,
  systemPrompt: string,
  pinnedSkills: string[],
): TaskManagementResult {
  if (!config.enable_task_management) {
    return { systemPrompt, pinnedSkills, heartbeatEligible: false };
  }
  // Keep the author's explicit pins; append any task skills not already present.
  const merged = [...pinnedSkills];
  for (const skill of TASK_MANAGEMENT_SKILLS) {
    if (!merged.includes(skill)) merged.push(skill);
  }
  return {
    systemPrompt: `${systemPrompt}\n\n${TASK_MANAGEMENT_BLOCK}`,
    pinnedSkills: merged,
    heartbeatEligible: true,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/unit/agents/task-management.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat add src/agents/task-management.ts tests/unit/agents/task-management.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat commit -m "feat: add task-management capability module (block + skills + applyTaskManagement)"
```

---

### Task A3: Wire the capability into bootstrap + build the eligible-agents set

**Files:**
- Modify: `src/index.ts` (agent bootstrap loop, ~lines 1302–1412)

> **Note:** `src/index.ts` is the bootstrap orchestrator and is not unit-tested directly; correctness here is verified by typecheck plus the integration test in Task B6 (which needs at least one enabled agent). Keep the change minimal and mechanical.

- [ ] **Step 1: Declare the eligible-agents set before the agent loop**

In `src/index.ts`, locate where agents are iterated to build runtimes (the loop that computes `const agentPinnedSkills = agentConfig.pinned_skills ?? [];` near line 1302). Immediately **before** that loop begins, add:

```typescript
// Agents with enable_task_management: true — read by the BacklogHeartbeat to
// know which source_agent_ids it may wake (and as the fallback target list).
const taskManagementAgents = new Set<string>();
```

- [ ] **Step 2: Apply the capability inside the loop**

Add the import at the top of `src/index.ts` (with the other `./agents/*` imports):

```typescript
import { applyTaskManagement } from './agents/task-management.js';
```

Inside the loop, after `systemPrompt` has been fully interpolated (after the `interpolateRuntimeContext(...)` branch ending ~line 1373) and after `const agentPinnedSkills = agentConfig.pinned_skills ?? [];`, insert:

```typescript
// Apply the enable_task_management capability: auto-pin task skills, append the
// discipline block, and register heartbeat-eligibility. No-op when the flag is off.
const taskMgmt = applyTaskManagement(agentConfig, systemPrompt, agentPinnedSkills);
systemPrompt = taskMgmt.systemPrompt;
const effectivePinnedSkills = taskMgmt.pinnedSkills;
if (taskMgmt.heartbeatEligible) {
  taskManagementAgents.add(agentConfig.name);
}
```

Then change the existing tool-definition line to use `effectivePinnedSkills`:

```typescript
// was: const agentToolDefs = skillRegistry.toToolDefinitions(agentPinnedSkills);
const agentToolDefs = skillRegistry.toToolDefinitions(effectivePinnedSkills);
```

(If `systemPrompt` is declared `const` at the interpolation site, change it to `let` so the reassignment above compiles.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat run typecheck`
Expected: PASS. (`taskManagementAgents` is unused until Task B5 — that is fine; it is a `Set` populated here and consumed there. If the linter flags unused, proceed; Task B5 consumes it in the same PR sequence. To avoid a lint break between commits, you may complete B5's wiring in the same commit as this step — see Task B5.)

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat add src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat commit -m "feat: wire enable_task_management into agent bootstrap"
```

---

## Part B — `BacklogHeartbeat`

### Task B1: The `tasks` config section

**Files:**
- Modify: `src/config.ts` (`YamlConfig` interface; add `resolveTasksConfig`)
- Modify: `schemas/default-config.schema.json`
- Modify: `config/default.yaml`
- Test: `tests/unit/config-tasks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/config-tasks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveTasksConfig, DEFAULT_TASKS_CONFIG } from '../../src/config.js';

describe('resolveTasksConfig', () => {
  it('returns defaults when no tasks block is present', () => {
    expect(resolveTasksConfig(undefined)).toEqual(DEFAULT_TASKS_CONFIG);
  });

  it('defaults are 60 / 5 / 4 / 48', () => {
    expect(DEFAULT_TASKS_CONFIG).toEqual({
      heartbeatIntervalMinutes: 60,
      heartbeatMaxWakesPerTick: 5,
      idleThresholdHours: 4,
      staleWaitThresholdHours: 48,
    });
  });

  it('overrides only the provided keys', () => {
    expect(resolveTasksConfig({ idleThresholdHours: 2 })).toEqual({
      heartbeatIntervalMinutes: 60,
      heartbeatMaxWakesPerTick: 5,
      idleThresholdHours: 2,
      staleWaitThresholdHours: 48,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/unit/config-tasks.test.ts`
Expected: FAIL — `resolveTasksConfig` / `DEFAULT_TASKS_CONFIG` not exported.

- [ ] **Step 3: Add the type + resolver in `src/config.ts`**

In `src/config.ts`, inside the `export interface YamlConfig { … }` (near the existing `scheduler?: { … }` field, before the closing brace ~line 281), add:

```typescript
  tasks?: {
    /** BacklogHeartbeat tick interval in minutes. Default 60. */
    heartbeatIntervalMinutes?: number;
    /** Max task wakes enqueued per heartbeat tick (global cap). Default 5. */
    heartbeatMaxWakesPerTick?: number;
    /** Hours an unblocked curia-owned task may sit untouched before the heartbeat
     *  pokes it. Default 4. */
    idleThresholdHours?: number;
    /** Hours a waiting/blocked task with no pending wake may sit before the
     *  heartbeat surfaces it as an orphaned wait. Default 48. */
    staleWaitThresholdHours?: number;
  };
```

Then, near the other exported config helpers/types (top-level, e.g. after the `Config` interface), add:

```typescript
export interface TasksConfig {
  heartbeatIntervalMinutes: number;
  heartbeatMaxWakesPerTick: number;
  idleThresholdHours: number;
  staleWaitThresholdHours: number;
}

export const DEFAULT_TASKS_CONFIG: TasksConfig = {
  heartbeatIntervalMinutes: 60,
  heartbeatMaxWakesPerTick: 5,
  idleThresholdHours: 4,
  staleWaitThresholdHours: 48,
};

/** Resolve the optional YAML tasks block to a fully-populated config with defaults. */
export function resolveTasksConfig(yaml: YamlConfig['tasks']): TasksConfig {
  return {
    heartbeatIntervalMinutes: yaml?.heartbeatIntervalMinutes ?? DEFAULT_TASKS_CONFIG.heartbeatIntervalMinutes,
    heartbeatMaxWakesPerTick: yaml?.heartbeatMaxWakesPerTick ?? DEFAULT_TASKS_CONFIG.heartbeatMaxWakesPerTick,
    idleThresholdHours: yaml?.idleThresholdHours ?? DEFAULT_TASKS_CONFIG.idleThresholdHours,
    staleWaitThresholdHours: yaml?.staleWaitThresholdHours ?? DEFAULT_TASKS_CONFIG.staleWaitThresholdHours,
  };
}
```

- [ ] **Step 4: Register the schema** (root is `additionalProperties:false`, so this is required or YAML load will reject the block)

In `schemas/default-config.schema.json`, add to the top-level `"properties"` object:

```json
"tasks": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "heartbeatIntervalMinutes": { "type": "number", "minimum": 1 },
    "heartbeatMaxWakesPerTick": { "type": "number", "minimum": 1 },
    "idleThresholdHours": { "type": "number", "minimum": 0 },
    "staleWaitThresholdHours": { "type": "number", "minimum": 0 }
  }
}
```

- [ ] **Step 5: Add the block to `config/default.yaml`**

Append a top-level block:

```yaml
# Autonomous task execution — BacklogHeartbeat tuning (design 2026-06-04 §3, §9.1).
tasks:
  heartbeatIntervalMinutes: 60
  heartbeatMaxWakesPerTick: 5
  idleThresholdHours: 4
  staleWaitThresholdHours: 48
```

- [ ] **Step 6: Run the test + the existing config tests**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/unit/config-tasks.test.ts`
Expected: PASS (3 tests).

Run the existing config test suite to confirm the schema change did not break load:
Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/unit/config.test.ts`
Expected: PASS (or, if no such file, run the full unit suite — see Task B6 closing command).

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat add src/config.ts schemas/default-config.schema.json config/default.yaml tests/unit/config-tasks.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat commit -m "feat: add tasks heartbeat config section with defaults"
```

---

### Task B2: The heartbeat selection query

**Files:**
- Modify: `src/db/queries/tasks.ts` (add `selectHeartbeatCandidates`)
- Test: `tests/integration/heartbeat-selection.test.ts` (real Postgres)

> The selection logic is SQL correctness, so the meaningful test is an integration test against real Postgres. A mock-pool unit test would only assert the row mapping, which is trivial; we test the real query instead.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/heartbeat-selection.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { selectHeartbeatCandidates } from '../../src/db/queries/tasks.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'HBSel Test';

/** Insert a task row directly; returns its id. `updatedAt` lets us simulate age. */
async function seedTask(
  pool: pg.Pool,
  opts: {
    title?: string;
    status: string;
    owner?: string;
    sourceAgentId?: string | null;
    blockedBy?: string | null;
    updatedAt: Date;
  },
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO tasks
       (agent_id, title, intent_anchor, status, progress, error_budget, owner,
        blocked_by_task_id, priority, source, source_agent_id, created_by, tags, updated_at)
     VALUES ($1,$2,$3,$4,'{}'::jsonb,'{}'::jsonb,$5,$6,50,'agent',$7,'test','{}',$8)
     RETURNING id`,
    [
      opts.sourceAgentId ?? 'coordinator',
      `${PREFIX} ${opts.title ?? opts.status}`,
      'seeded',
      opts.status,
      opts.owner ?? 'curia',
      opts.blockedBy ?? null,
      opts.sourceAgentId ?? null,
      opts.updatedAt,
    ],
  );
  return (rows[0] as { id: string }).id;
}

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

describeIf('selectHeartbeatCandidates', () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM tasks LIMIT 0');
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
  const opts = { eligibleAgents: ['coordinator', 'ceo-inbox'], idleThresholdHours: 4, staleWaitThresholdHours: 48, maxWakes: 5 };

  it('selects an idle, unblocked, curia-owned task older than the idle threshold', async () => {
    const id = await seedTask(pool, { status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(5) });
    const got = await selectHeartbeatCandidates(pool, opts);
    expect(got.map((c) => c.id)).toContain(id);
  });

  it('ignores a task touched within the idle threshold', async () => {
    await seedTask(pool, { status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(1) });
    const got = await selectHeartbeatCandidates(pool, opts);
    expect(got).toHaveLength(0);
  });

  it('excludes a task blocked by an unfinished task', async () => {
    const blocker = await seedTask(pool, { title: 'blocker', status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(10) });
    await seedTask(pool, { title: 'blocked', status: 'blocked', sourceAgentId: 'ceo-inbox', blockedBy: blocker, updatedAt: hoursAgo(10) });
    const got = await selectHeartbeatCandidates(pool, opts);
    // only the blocker (open, idle) is eligible; the blocked child is excluded
    expect(got.map((c) => c.id)).toEqual([blocker]);
  });

  it('includes a blocked task once its blocker is done (stale-wait path)', async () => {
    const blocker = await seedTask(pool, { title: 'doneblocker', status: 'done', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(60) });
    const child = await seedTask(pool, { title: 'unblocked', status: 'blocked', sourceAgentId: 'ceo-inbox', blockedBy: blocker, updatedAt: hoursAgo(60) });
    const got = await selectHeartbeatCandidates(pool, opts);
    expect(got.map((c) => c.id)).toContain(child);
  });

  it('skips a task that already has a pending wake', async () => {
    const id = await seedTask(pool, { status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(10) });
    await pool.query(
      `INSERT INTO scheduled_jobs (agent_id, cron_expr, run_at, task_payload, status, next_run_at, created_by, task_id)
       VALUES ('ceo-inbox', NULL, now(), '{}'::jsonb, 'pending', now(), 'test', $1)`,
      [id],
    );
    const got = await selectHeartbeatCandidates(pool, opts);
    expect(got.map((c) => c.id)).not.toContain(id);
  });

  it('returns at most one entry per effective agent', async () => {
    await seedTask(pool, { title: 'a', status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(10) });
    await seedTask(pool, { title: 'b', status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(8) });
    const got = await selectHeartbeatCandidates(pool, opts);
    expect(got.filter((c) => c.agentId === 'ceo-inbox')).toHaveLength(1);
  });

  it('routes a non-eligible / null source_agent_id to the coordinator fallback', async () => {
    const id = await seedTask(pool, { status: 'open', sourceAgentId: null, updatedAt: hoursAgo(10) });
    const got = await selectHeartbeatCandidates(pool, opts);
    const row = got.find((c) => c.id === id);
    expect(row?.agentId).toBe('coordinator');
  });

  it('does not advance a non-curia idle task (owner=ceo, open)', async () => {
    await seedTask(pool, { status: 'open', owner: 'ceo', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(10) });
    const got = await selectHeartbeatCandidates(pool, opts);
    expect(got).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `DATABASE_URL=$DATABASE_URL pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/integration/heartbeat-selection.test.ts`
Expected: FAIL — `selectHeartbeatCandidates` is not exported. (If `DATABASE_URL` is unset the suite SKIPS; set it to your empty test DB to actually run.)

- [ ] **Step 3: Implement the query**

In `src/db/queries/tasks.ts`, add (import `Pool` type is already present in this module):

```typescript
export interface HeartbeatCandidate {
  /** The task to wake. */
  id: string;
  /** The agent that will receive the wake — the task's source_agent_id, or the
   *  fallback agent when source_agent_id is null or not heartbeat-eligible. */
  agentId: string;
}

export interface SelectHeartbeatOptions {
  /** Heartbeat-eligible agent names (enable_task_management: true). */
  eligibleAgents: string[];
  idleThresholdHours: number;
  staleWaitThresholdHours: number;
  /** Global cap on candidates returned per call. */
  maxWakes: number;
  /** Agent that receives wakes for null / non-eligible owners. Default 'coordinator'. */
  fallbackAgentId?: string;
}

/** Select the heartbeat's wake candidates: one entry-point task per effective owner
 *  agent (idle-unblocked curia work, or orphaned waits past their threshold), globally
 *  capped, most-overdue first. Deterministic — no domain reasoning. */
export async function selectHeartbeatCandidates(
  pool: Pool,
  opts: SelectHeartbeatOptions,
): Promise<HeartbeatCandidate[]> {
  if (opts.eligibleAgents.length === 0) return [];
  const fallback = opts.fallbackAgentId ?? 'coordinator';
  const { rows } = await pool.query(
    `WITH candidates AS (
       SELECT
         t.id,
         CASE WHEN t.source_agent_id = ANY($1::text[]) THEN t.source_agent_id ELSE $4 END AS effective_agent,
         t.updated_at
       FROM tasks t
       WHERE t.status IN ('open','in_progress','waiting','blocked')
         AND (t.blocked_by_task_id IS NULL OR EXISTS (
               SELECT 1 FROM tasks b
               WHERE b.id = t.blocked_by_task_id AND b.status IN ('done','cancelled')))
         AND NOT EXISTS (
               SELECT 1 FROM scheduled_jobs sj
               WHERE sj.task_id = t.id AND sj.status = 'pending')
         AND (
               (t.owner = 'curia' AND t.status IN ('open','in_progress')
                  AND t.updated_at < now() - make_interval(hours => $2))
            OR (t.status IN ('waiting','blocked')
                  AND t.updated_at < now() - make_interval(hours => $3))
             )
     ),
     per_agent AS (
       SELECT DISTINCT ON (effective_agent) id, effective_agent, updated_at
       FROM candidates
       ORDER BY effective_agent, updated_at ASC
     )
     SELECT id, effective_agent
     FROM per_agent
     ORDER BY updated_at ASC
     LIMIT $5`,
    [opts.eligibleAgents, opts.idleThresholdHours, opts.staleWaitThresholdHours, fallback, opts.maxWakes],
  );
  return rows.map((r) => {
    const row = r as { id: string; effective_agent: string };
    return { id: row.id, agentId: row.effective_agent };
  });
}
```

> Note: `make_interval(hours => $2)` binds `$2` as a numeric parameter — fully parameterized, no string interpolation (per CLAUDE.md SQL rule).

- [ ] **Step 4: Run to verify it passes**

Run: `DATABASE_URL=$DATABASE_URL pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/integration/heartbeat-selection.test.ts`
Expected: PASS (8 tests) when `DATABASE_URL` points at the test DB.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat add src/db/queries/tasks.ts tests/integration/heartbeat-selection.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat commit -m "feat: add selectHeartbeatCandidates query (idle + orphaned-wait, per-agent cap)"
```

---

### Task B3: `enqueueTaskWake` on `SchedulerService`

**Files:**
- Modify: `src/scheduler/scheduler-service.ts` (add public method `enqueueTaskWake`)
- Test: `tests/unit/scheduler/enqueue-task-wake.test.ts`

> `createJob` always creates a *new* task when given an `intent_anchor`; the heartbeat must wake an **existing** task. `enqueueTaskWake` inserts a one-shot `scheduled_jobs` row with `task_id` preset, so the existing dispatch path routes it to the owning agent with full task context.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scheduler/enqueue-task-wake.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SchedulerService } from '../../../src/scheduler/scheduler-service.js';

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
}

describe('SchedulerService.enqueueTaskWake', () => {
  it('inserts a one-shot pending scheduled_jobs row carrying the existing task_id', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'job-9' }] }) };
    const bus = { publish: vi.fn(), subscribe: vi.fn() };
    const svc = new SchedulerService(
      pool as unknown as import('pg').Pool,
      bus as never,
      mockLogger() as never,
      'America/Toronto',
    );

    const runAt = new Date('2026-06-04T12:00:00Z');
    const result = await svc.enqueueTaskWake({ taskId: 'task-7', agentId: 'ceo-inbox', runAt });

    expect(result.jobId).toBe('job-9');
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO scheduled_jobs/i);
    expect(sql).toMatch(/task_id/);
    // status pending, one-shot (cron NULL), task_id = the EXISTING task
    expect(params).toContain('task-7');
    expect(params).toContain('ceo-inbox');
    expect(params).toContain(runAt);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/unit/scheduler/enqueue-task-wake.test.ts`
Expected: FAIL — `enqueueTaskWake` is not a function.

- [ ] **Step 3: Implement the method**

In `src/scheduler/scheduler-service.ts`, add a public method to the `SchedulerService` class. Use the same `this.pool` and the configured-timezone field set in the constructor (the 4th constructor arg, `config.timezone` — match its existing private field name; shown here as `this.defaultTimezone`):

```typescript
/** Enqueue a one-shot wake for an EXISTING task. Inserts a pending scheduled_jobs
 *  row with task_id preset so the dispatcher routes it to `agentId` with full task
 *  context. Used by the BacklogHeartbeat. Does not create a new task. */
async enqueueTaskWake(params: {
  taskId: string;
  agentId: string;
  runAt: Date;
  createdBy?: string;
}): Promise<{ jobId: string }> {
  const { taskId, agentId, runAt, createdBy = 'heartbeat' } = params;
  const { rows } = await this.pool.query(
    `INSERT INTO scheduled_jobs
       (agent_id, cron_expr, run_at, task_payload, status, next_run_at, created_by, timezone, task_id)
     VALUES ($1, NULL, $2, $3, 'pending', $2, $4, $5, $6)
     RETURNING id`,
    [
      agentId,
      runAt,
      JSON.stringify({ type: 'task-wake', task_id: taskId }),
      createdBy,
      this.defaultTimezone,
      taskId,
    ],
  );
  return { jobId: (rows[0] as { id: string }).id };
}
```

> If the private timezone field has a different name, use that name. `timezone` is included because `scheduled_jobs.timezone` is non-defaulted in some migrations; passing the service default is safe for a one-shot `run_at` job.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/unit/scheduler/enqueue-task-wake.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat add src/scheduler/scheduler-service.ts tests/unit/scheduler/enqueue-task-wake.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat commit -m "feat: add SchedulerService.enqueueTaskWake for waking existing tasks"
```

---

### Task B4: The `BacklogHeartbeat` component

**Files:**
- Create: `src/scheduler/backlog-heartbeat.ts`
- Test: `tests/unit/scheduler/backlog-heartbeat.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scheduler/backlog-heartbeat.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BacklogHeartbeat } from '../../../src/scheduler/backlog-heartbeat.js';
import * as tasksQueries from '../../../src/db/queries/tasks.js';

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
}

function makeHeartbeat(overrides: Partial<ConstructorParameters<typeof BacklogHeartbeat>[0]> = {}) {
  const enqueueTaskWake = vi.fn().mockResolvedValue({ jobId: 'job-x' });
  const schedulerService = { enqueueTaskWake } as never;
  const pool = { query: vi.fn() } as never;
  const hb = new BacklogHeartbeat({
    pool,
    logger: mockLogger() as never,
    schedulerService,
    eligibleAgents: new Set(['coordinator', 'ceo-inbox']),
    intervalMinutes: 60,
    maxWakesPerTick: 5,
    idleThresholdHours: 4,
    staleWaitThresholdHours: 48,
    ...overrides,
  });
  return { hb, enqueueTaskWake };
}

describe('BacklogHeartbeat.tick', () => {
  afterEach(() => vi.restoreAllMocks());

  it('enqueues one wake per selected candidate and returns the count', async () => {
    vi.spyOn(tasksQueries, 'selectHeartbeatCandidates').mockResolvedValue([
      { id: 't1', agentId: 'ceo-inbox' },
      { id: 't2', agentId: 'coordinator' },
    ]);
    const { hb, enqueueTaskWake } = makeHeartbeat();
    const count = await hb.tick();
    expect(count).toBe(2);
    expect(enqueueTaskWake).toHaveBeenCalledTimes(2);
    expect(enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1', agentId: 'ceo-inbox' }));
    expect(enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't2', agentId: 'coordinator' }));
  });

  it('passes config thresholds and the eligible-agents list to the selector', async () => {
    const spy = vi.spyOn(tasksQueries, 'selectHeartbeatCandidates').mockResolvedValue([]);
    const { hb } = makeHeartbeat();
    await hb.tick();
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eligibleAgents: ['coordinator', 'ceo-inbox'],
        idleThresholdHours: 4,
        staleWaitThresholdHours: 48,
        maxWakes: 5,
      }),
    );
  });

  it('continues after a single enqueue failure', async () => {
    vi.spyOn(tasksQueries, 'selectHeartbeatCandidates').mockResolvedValue([
      { id: 't1', agentId: 'ceo-inbox' },
      { id: 't2', agentId: 'coordinator' },
    ]);
    const { hb, enqueueTaskWake } = makeHeartbeat();
    enqueueTaskWake.mockRejectedValueOnce(new Error('db blip'));
    const count = await hb.tick();
    expect(count).toBe(1); // second succeeds despite first failing
    expect(enqueueTaskWake).toHaveBeenCalledTimes(2);
  });
});

describe('BacklogHeartbeat start/stop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ticks on the configured interval and stops cleanly', async () => {
    vi.spyOn(tasksQueries, 'selectHeartbeatCandidates').mockResolvedValue([]);
    const { hb } = makeHeartbeat({ intervalMinutes: 60 });
    hb.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(tasksQueries.selectHeartbeatCandidates).toHaveBeenCalledTimes(1);
    hb.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000 * 3);
    expect(tasksQueries.selectHeartbeatCandidates).toHaveBeenCalledTimes(1); // no more after stop
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/unit/scheduler/backlog-heartbeat.test.ts`
Expected: FAIL — cannot resolve `backlog-heartbeat.js`.

- [ ] **Step 3: Implement the component**

Create `src/scheduler/backlog-heartbeat.ts`:

```typescript
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { SchedulerService } from './scheduler-service.js';
import { selectHeartbeatCandidates } from '../db/queries/tasks.js';

export interface BacklogHeartbeatOptions {
  pool: Pool;
  logger: Logger;
  schedulerService: SchedulerService;
  /** Heartbeat-eligible agent names (enable_task_management: true). */
  eligibleAgents: Set<string>;
  intervalMinutes: number;
  maxWakesPerTick: number;
  idleThresholdHours: number;
  staleWaitThresholdHours: number;
  /** Wake target for null / non-eligible owners. Default 'coordinator'. */
  fallbackAgentId?: string;
}

/** System-layer component: on an hourly interval, selects idle/stale tasks and
 *  enqueues one-shot wakes routed to each owning agent. Deterministic; does no
 *  domain reasoning. The conductor, never an instrument. */
export class BacklogHeartbeat {
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(private readonly opts: BacklogHeartbeatOptions) {}

  start(): void {
    if (this.intervalHandle) return;
    const ms = this.opts.intervalMinutes * 60_000;
    this.intervalHandle = setInterval(() => {
      this.tick().catch((err) => {
        this.opts.logger.error({ err }, 'BacklogHeartbeat: unhandled error in tick');
      });
    }, ms);
    this.opts.logger.info({ intervalMinutes: this.opts.intervalMinutes }, 'BacklogHeartbeat started');
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.opts.logger.info('BacklogHeartbeat stopped');
  }

  /** One tick: select candidates and enqueue a wake for each. Returns the number
   *  of wakes successfully enqueued. */
  async tick(): Promise<number> {
    const candidates = await selectHeartbeatCandidates(this.opts.pool, {
      eligibleAgents: [...this.opts.eligibleAgents],
      idleThresholdHours: this.opts.idleThresholdHours,
      staleWaitThresholdHours: this.opts.staleWaitThresholdHours,
      maxWakes: this.opts.maxWakesPerTick,
      fallbackAgentId: this.opts.fallbackAgentId ?? 'coordinator',
    });
    if (candidates.length === 0) return 0;

    const runAt = new Date();
    let enqueued = 0;
    for (const c of candidates) {
      try {
        await this.opts.schedulerService.enqueueTaskWake({ taskId: c.id, agentId: c.agentId, runAt });
        enqueued += 1;
      } catch (err) {
        this.opts.logger.error({ err, taskId: c.id, agentId: c.agentId }, 'BacklogHeartbeat: failed to enqueue wake');
      }
    }
    this.opts.logger.info({ enqueued, considered: candidates.length }, 'BacklogHeartbeat: tick complete');
    return enqueued;
  }
}
```

> If `Logger` is not exported from `pino` in this codebase, import it from the project's logger module instead (match how `scheduler.ts` types its `logger`).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/unit/scheduler/backlog-heartbeat.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat add src/scheduler/backlog-heartbeat.ts tests/unit/scheduler/backlog-heartbeat.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat commit -m "feat: add BacklogHeartbeat component (tick + start/stop)"
```

---

### Task B5: Bootstrap wiring (construct + start + stop)

**Files:**
- Modify: `src/index.ts` (construct after the Scheduler ~line 1177; start after `scheduler.start()` ~line 1485; stop in the shutdown handler ~lines 1652–1727)

> This consumes the `taskManagementAgents` set built in Task A3 and the `resolveTasksConfig` from Task B1. If A3 left `taskManagementAgents` unused, this step makes it used — landing A3 and B5 in the same PR keeps every commit lint-clean.

- [ ] **Step 1: Add imports**

At the top of `src/index.ts`:

```typescript
import { BacklogHeartbeat } from './scheduler/backlog-heartbeat.js';
import { resolveTasksConfig } from './config.js';  // if not already importing from './config.js', add resolveTasksConfig to the existing import
```

- [ ] **Step 2: Construct after the Scheduler is built**

After the `const scheduler = new Scheduler({ … })` construction (~line 1177) and after `taskManagementAgents` is fully populated by the agent loop, add:

```typescript
// Autonomous task execution: the deterministic hourly heartbeat that wakes idle/stale
// tasks. Reads the tasks table, writes one-shot scheduled_jobs rows; the scheduler
// dispatches them. See docs/wip/2026-06-04-task-execution-heartbeat-design.md §3.
const tasksConfig = resolveTasksConfig(yamlConfig.tasks);
const backlogHeartbeat = new BacklogHeartbeat({
  pool,
  logger,
  schedulerService,
  eligibleAgents: taskManagementAgents,
  intervalMinutes: tasksConfig.heartbeatIntervalMinutes,
  maxWakesPerTick: tasksConfig.heartbeatMaxWakesPerTick,
  idleThresholdHours: tasksConfig.idleThresholdHours,
  staleWaitThresholdHours: tasksConfig.staleWaitThresholdHours,
});
```

> Use the variable name that holds the loaded YAML config in this file (the exploration shows it referenced as `yamlConfig`; if it is named differently, match it). `schedulerService` and `pool` and `logger` are already in scope at this point.

- [ ] **Step 3: Start it (after `scheduler.start()`)**

After `scheduler.start();` (~line 1485):

```typescript
backlogHeartbeat.start();
```

- [ ] **Step 4: Stop it in the shutdown handler**

In the `shutdown` function (~lines 1652–1727), alongside `scheduler.stop();`, add (before `await pool.end();`):

```typescript
backlogHeartbeat.stop();
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat add src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat commit -m "feat: construct, start, and stop BacklogHeartbeat in bootstrap"
```

---

### Task B6: End-to-end integration test (selection → enqueue → dispatch-ready row)

**Files:**
- Test: `tests/integration/backlog-heartbeat.test.ts` (real Postgres)

- [ ] **Step 1: Write the test**

Create `tests/integration/backlog-heartbeat.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { BacklogHeartbeat } from '../../src/scheduler/backlog-heartbeat.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { createLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const PREFIX = 'HBE2E Test';

async function seedTask(pool: pg.Pool, o: { status: string; owner?: string; sourceAgentId?: string | null; updatedAt: Date }): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, source_agent_id, created_by, tags, updated_at)
     VALUES ($1,$2,'seeded',$3,'{}'::jsonb,'{}'::jsonb,$4,50,'agent',$5,'test','{}',$6) RETURNING id`,
    [o.sourceAgentId ?? 'coordinator', `${PREFIX} ${o.status}`, o.status, o.owner ?? 'curia', o.sourceAgentId ?? null, o.updatedAt],
  );
  return (rows[0] as { id: string }).id;
}

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

describeIf('BacklogHeartbeat end-to-end', () => {
  let pool: pg.Pool;
  const logger = createLogger('silent');
  beforeAll(async () => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  it('enqueues exactly one pending wake per eligible agent, routed correctly', async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
    const idA = await seedTask(pool, { status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(5) });
    await seedTask(pool, { status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: hoursAgo(6) }); // second for same agent — should NOT also wake
    const idC = await seedTask(pool, { status: 'open', sourceAgentId: 'coordinator', updatedAt: hoursAgo(5) });

    const schedulerService = new SchedulerService(pool, { publish: vi.fn(), subscribe: vi.fn() } as never, logger, 'UTC');
    const hb = new BacklogHeartbeat({
      pool, logger, schedulerService,
      eligibleAgents: new Set(['coordinator', 'ceo-inbox']),
      intervalMinutes: 60, maxWakesPerTick: 5, idleThresholdHours: 4, staleWaitThresholdHours: 48,
    });

    const enqueued = await hb.tick();
    expect(enqueued).toBe(2); // one per agent

    const { rows } = await pool.query(
      `SELECT agent_id, task_id, status, cron_expr FROM scheduled_jobs
       WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1) ORDER BY agent_id`,
      [`${PREFIX}%`],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r as { agent_id: string }).agent_id)).toEqual(['ceo-inbox', 'coordinator']);
    for (const r of rows) {
      const row = r as { status: string; cron_expr: string | null; task_id: string };
      expect(row.status).toBe('pending');
      expect(row.cron_expr).toBeNull(); // one-shot
    }
    // The two waked tasks are idA (or its sibling) and idC; a wake exists for ceo-inbox + coordinator.
    const wakedTaskIds = rows.map((r) => (r as { task_id: string }).task_id);
    expect(wakedTaskIds).toContain(idC);
    expect(wakedTaskIds.some((t) => t === idA || t !== idC)).toBe(true);
  });

  it('does not re-enqueue on a second tick (pending wake dedup)', async () => {
    await seedTask(pool, { status: 'open', sourceAgentId: 'ceo-inbox', updatedAt: new Date(Date.now() - 5 * 3600_000) });
    const schedulerService = new SchedulerService(pool, { publish: vi.fn(), subscribe: vi.fn() } as never, logger, 'UTC');
    const hb = new BacklogHeartbeat({
      pool, logger, schedulerService,
      eligibleAgents: new Set(['ceo-inbox']),
      intervalMinutes: 60, maxWakesPerTick: 5, idleThresholdHours: 4, staleWaitThresholdHours: 48,
    });
    expect(await hb.tick()).toBe(1);
    expect(await hb.tick()).toBe(0); // already has a pending wake
  });
});
```

- [ ] **Step 2: Run**

Run: `DATABASE_URL=$DATABASE_URL pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/integration/backlog-heartbeat.test.ts`
Expected: PASS (2 tests) against the test DB; SKIPPED when `DATABASE_URL` is unset.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat add tests/integration/backlog-heartbeat.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat commit -m "test: end-to-end BacklogHeartbeat selection + enqueue against Postgres"
```

---

## Part C — Enable the coordinator (canary)

### Task C1: Flip the flag on the coordinator

**Files:**
- Modify: `agents/coordinator.yaml`

> The injected block (Task A2) supplies the executor/decomposition/reification discipline, so enabling the flag also delivers the project-execution guidance. The coordinator currently pins the four `task-*` skills manually (lines ~644–647) and has its `## Scheduling and Task Management` prose section (lines ~308–329) — the manual pins become redundant; leave the prose section in place (it covers scheduler-vs-task routing the block does not).

- [ ] **Step 1: Set the flag, drop redundant manual pins, add error_budget, bump version**

In `agents/coordinator.yaml`:

1. Add at the top level (near `allow_discovery:`):

```yaml
enable_task_management: true
```

2. Remove the four now-redundant lines from `pinned_skills` (they are auto-pinned by the flag):

```yaml
  - task-create
  - task-list
  - task-update
  - task-complete
```

3. Add a modest burst budget (the coordinator has none today) so project bursts are bounded:

```yaml
error_budget:
  max_turns: 40
  max_cost_usd: 1.00
```

4. Bump `version` (per CLAUDE.md: new capability → minor bump). Change `version: "0.5.1"` to `version: "0.6.0"`.

- [ ] **Step 2: Verify the agent still loads + skills resolve**

Run the existing agent/loader test suite (and any coordinator config test):
Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/unit/agents`
Expected: PASS. If a test asserts the coordinator's exact `pinned_skills` count, update it to reflect the four skills now arriving via the flag rather than manual pins.

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat add agents/coordinator.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat commit -m "feat: enable_task_management on coordinator (canary); add error_budget"
```

---

### Task C2: CHANGELOG + full suite

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add `[Unreleased]` entries**

Under `## [Unreleased]` → `### Added`:

```markdown
- **`enable_task_management`** — declarative agent capability that auto-pins the task skills, injects the executor/reification discipline block, and marks an agent heartbeat-eligible. (design 2026-06-04 §6)
- **`BacklogHeartbeat`** — deterministic hourly System component that wakes idle/stale tasks by enqueuing one-shot scheduler jobs, one per owning agent, globally capped. (design 2026-06-04 §3)
```

Under `### Changed`:

```markdown
- **coordinator** — task management now arrives via `enable_task_management: true` (replacing manual `task-*` pins); added a bounded `error_budget` for project bursts.
```

- [ ] **Step 2: Run the full unit suite + typecheck**

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test`
Expected: PASS (all existing + new unit tests; integration tests skip without `DATABASE_URL`).

Run: `pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat run typecheck`
Expected: PASS.

If `DATABASE_URL` is available, run the integration tests too:
Run: `DATABASE_URL=$DATABASE_URL pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat test -- tests/integration/heartbeat-selection.test.ts tests/integration/backlog-heartbeat.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-task-exec-heartbeat commit -m "docs: changelog for task-execution heartbeat foundation"
```

---

## Self-Review (against the design spec)

**Spec coverage:**
- §3 heartbeat (deterministic enqueuer) → Tasks B2 (selection), B3 (enqueue), B4 (component), B5 (wiring), B6 (e2e). ✔
- §3.1 pick-the-agent / per-agent=1 / global cap → B2 `DISTINCT ON (effective_agent)` + `LIMIT maxWakes`; tested in B2 + B6. ✔
- §3.1 idle (4h) vs orphaned-wait (48h) thresholds → B1 config + B2 query predicate; tested in B2. ✔
- §3 blocked_by exclusion + wake dedup → B2 query; tested in B2. ✔
- §6 capability flag (skills + block + eligibility) → Tasks A1, A2, A3; tested in A2. ✔
- §6 fixed-slot injection, default false, manual-import escape hatch → A2/A3 (append; no-op when off; merge preserves explicit pins). ✔
- §6 disabled-owner → coordinator fallback → B2 `effective_agent` CASE; tested in B2. ✔
- §8 coordinator enablement + error_budget → Task C1. ✔
- §9.1 config keys → Task B1. ✔
- §1.1 scheduler reads only scheduled_jobs → preserved: heartbeat writes scheduled_jobs, never touches the scheduler's read path. ✔
- §9 zero new columns → no migration in this plan (stretch `last_advanced_at` deferred). ✔

**Out of foundation scope (second plan):** ceo-inbox #840 (reification + resume + overflow), meeting-debrief/research-analyst onboarding, the LLM groomer, `last_advanced_at`.

**Placeholder scan:** none — every code step contains complete code; every command has expected output. The two soft notes (`this.defaultTimezone` field name; `yamlConfig` variable name) are "match the existing identifier" pointers, with the concrete fallback stated.

**Type consistency:** `HeartbeatCandidate { id, agentId }` is produced by `selectHeartbeatCandidates` (B2) and consumed by `BacklogHeartbeat.tick` (B4) and asserted in the B4 mock — names match. `enqueueTaskWake({ taskId, agentId, runAt })` signature matches its call in `tick`. `resolveTasksConfig` / `TasksConfig` (B1) consumed in B5. `applyTaskManagement` result shape (A2) consumed in A3.

**Migration-collision check (per repo CLAUDE.md):** this plan adds **no** migration, so no `NNN_` collision risk. (If the stretch `last_advanced_at` column is later added, claim the next free number after `ls src/db/migrations/ | sort`.)
