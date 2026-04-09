# Intent Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing `intent_anchor` DB column through to the agent runtime so it is injected into `effectiveSystemPrompt` on every scheduler burst, preventing multi-burst task drift.

**Architecture:** `AgentTaskPayload` gains an optional `intentAnchor` field; the scheduler passes the anchor through the event rather than the content bundle; the runtime appends a `## Original Task Intent` block to `effectiveSystemPrompt` when the field is present. Coordinator YAML gets explicit guidance on when to supply it.

**Tech Stack:** TypeScript/ESM, Vitest, Postgres (no new dependencies)

---

### Task 1: Add `intentAnchor` to `AgentTaskPayload`

**Files:**
- Modify: `src/bus/events.ts:29-38`

This is the type change that unblocks everything downstream. No unit test needed — TypeScript will catch misuse at compile time, and the downstream tests in Tasks 2 and 3 exercise the real behaviour.

- [ ] **Step 1: Add the field to the interface**

In `src/bus/events.ts`, update `AgentTaskPayload` (lines 29–38):

```ts
interface AgentTaskPayload {
  agentId: string;
  conversationId: string;
  channelId: string;
  senderId: string;
  content: string;
  metadata?: Record<string, unknown>;
  /** Resolved sender context from the contact resolver. Undefined if contacts not configured. */
  senderContext?: import('../contacts/types.js').InboundSenderContext;
  /** Original task intent for persistent scheduler tasks. Undefined for one-shot and direct tasks.
   *  Injected into effectiveSystemPrompt by the runtime to prevent multi-burst drift. */
  intentAnchor?: string;
}
```

No change to `createAgentTask()` — it destructures `parentEventId` and spreads the rest, so `intentAnchor` flows through automatically.

- [ ] **Step 2: Build to confirm no type errors**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor run build
```

Expected: clean build, zero errors.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor add src/bus/events.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor commit -m "feat: add intentAnchor to AgentTaskPayload"
```

---

### Task 2: Update scheduler to pass anchor in payload, not content

**Files:**
- Modify: `src/scheduler/scheduler.ts` (the `fireJob` method, ~lines 214–223 and 234–242)
- Test: `tests/unit/scheduler/scheduler.test.ts`

The existing test at line 211–230 asserts `content.intent_anchor === 'weekly-report'`. After this task that assertion must be updated: anchor goes in the payload, not the content.

- [ ] **Step 1: Write the failing tests**

Open `tests/unit/scheduler/scheduler.test.ts`. Find the `describe('pollDueJobs')` block.

**Replace** the existing `'injects persistent task context when agent_task is linked'` test (lines 211–230) with these three tests:

```ts
it('passes intentAnchor in event payload for persistent tasks', async () => {
  const row = fakeDbRow({
    agent_task_id: 'task-aaa',
    intent_anchor: 'weekly-report',
    progress: { step: 3 },
  });
  pool.query.mockResolvedValueOnce({ rows: [row] });
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // claim

  await scheduler.pollDueJobs();

  const [, taskEvent] = bus.publish.mock.calls[1] as [string, { payload: { intentAnchor?: string } }];
  expect(taskEvent.payload.intentAnchor).toBe('weekly-report');
});

it('does NOT include intent_anchor in content bundle for persistent tasks', async () => {
  const row = fakeDbRow({
    agent_task_id: 'task-aaa',
    intent_anchor: 'weekly-report',
    progress: { step: 3 },
  });
  pool.query.mockResolvedValueOnce({ rows: [row] });
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

  await scheduler.pollDueJobs();

  const [, taskEvent] = bus.publish.mock.calls[1] as [string, { payload: { content: string } }];
  const content = JSON.parse(taskEvent.payload.content);
  expect(content.intent_anchor).toBeUndefined();
  expect(content.progress).toEqual({ step: 3 });
  expect(content.task_payload).toEqual({ skill: 'morning-brief' });
});

it('does not pass intentAnchor for jobs without a linked agent_task', async () => {
  const row = fakeDbRow(); // no agent_task_id
  pool.query.mockResolvedValueOnce({ rows: [row] });
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

  await scheduler.pollDueJobs();

  const [, taskEvent] = bus.publish.mock.calls[1] as [string, { payload: { intentAnchor?: string } }];
  expect(taskEvent.payload.intentAnchor).toBeUndefined();
});
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor test -- tests/unit/scheduler/scheduler.test.ts
```

Expected: the three new tests fail. Existing tests continue to pass.

- [ ] **Step 3: Update `fireJob()` in `src/scheduler/scheduler.ts`**

Find the content-building block (around lines 214–223):

```ts
// Build the agent.task content, injecting persistent task context if available.
let content = JSON.stringify(job.taskPayload);
if (job.agentTaskId && job.intentAnchor) {
  const context = {
    intent_anchor: job.intentAnchor,
    progress: job.progress ?? {},
    task_payload: job.taskPayload,
  };
  content = JSON.stringify(context);
}
```

Replace with:

```ts
// Build the agent.task content. For persistent tasks, include progress and
// the original task payload so the agent has execution context. Intent anchor
// is passed in the event payload (not content) so the runtime can inject it
// into the system prompt as a non-negotiable behavioral instruction.
let content = JSON.stringify(job.taskPayload);
if (job.agentTaskId) {
  content = JSON.stringify({
    progress: job.progress ?? {},
    task_payload: job.taskPayload,
  });
}
```

Then find the `createAgentTask()` call (around lines 234–242):

```ts
const taskEvent = createAgentTask({
  agentId: job.agentId,
  conversationId: `scheduler:${job.id}`,
  channelId: 'scheduler',
  senderId: 'scheduler',
  content,
  parentEventId: firedEvent.id,
});
```

Replace with:

```ts
const taskEvent = createAgentTask({
  agentId: job.agentId,
  conversationId: `scheduler:${job.id}`,
  channelId: 'scheduler',
  senderId: 'scheduler',
  content,
  // Pass the anchor in the payload so the runtime injects it into the system
  // prompt. null (no linked agent_task) becomes undefined (field omitted).
  intentAnchor: job.intentAnchor ?? undefined,
  parentEventId: firedEvent.id,
});
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor test -- tests/unit/scheduler/scheduler.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor add src/scheduler/scheduler.ts tests/unit/scheduler/scheduler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor commit -m "feat: pass intentAnchor in event payload instead of content bundle"
```

---

### Task 3: Inject intent anchor into `effectiveSystemPrompt` in the runtime

**Files:**
- Modify: `src/agents/runtime.ts` (~line 189, after the time context block)
- Test: `tests/unit/agents/runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `tests/unit/agents/runtime.test.ts`. Add these two tests inside the existing `describe('AgentRuntime')` block, after the existing tests:

```ts
it('appends intent anchor to system prompt when intentAnchor is present', async () => {
  const provider = createMockProvider('Done.');
  const runtime = new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'You are helpful.',
    provider,
    bus,
    logger: createLogger('error'),
  });
  runtime.register();

  const task = createAgentTask({
    agentId: 'coordinator',
    conversationId: 'conv-1',
    channelId: 'scheduler',
    senderId: 'scheduler',
    content: JSON.stringify({ progress: {}, task_payload: { task: 'dedup scan' } }),
    intentAnchor: 'Run weekly contacts dedup scan and present duplicates to Joseph.',
    parentEventId: 'parent-1',
  });
  await bus.publish('dispatch', task);

  expect(provider.chat).toHaveBeenCalledWith(
    expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining(
            '## Original Task Intent\nRun weekly contacts dedup scan and present duplicates to Joseph.',
          ),
        }),
      ]),
    }),
  );
});

it('does not append intent anchor when intentAnchor is absent', async () => {
  const provider = createMockProvider('Hello back!');
  const runtime = new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'You are helpful.',
    provider,
    bus,
    logger: createLogger('error'),
  });
  runtime.register();

  const task = createAgentTask({
    agentId: 'coordinator',
    conversationId: 'conv-1',
    channelId: 'cli',
    senderId: 'user',
    content: 'Hello',
    parentEventId: 'parent-1',
  });
  await bus.publish('dispatch', task);

  const chatCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
  const systemMsg = chatCall.messages.find(m => m.role === 'system');
  expect(systemMsg?.content).not.toContain('## Original Task Intent');
});
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor test -- tests/unit/agents/runtime.test.ts
```

Expected: the two new tests fail. All existing tests continue to pass.

- [ ] **Step 3: Add anchor injection to `processTask()` in `src/agents/runtime.ts`**

Find the time context block (ending around line 189):

```ts
    const timezone = this.config.timezone?.trim();
    if (timezone) {
      try {
        effectiveSystemPrompt += '\n\n' + formatTimeContextBlock(timezone, new Date());
      } catch (err) {
        logger.error({ err, agentId, timezone }, 'formatTimeContextBlock failed — time context not injected; check TIMEZONE config');
      }
    }
```

Add the intent anchor block immediately after it:

```ts
    const timezone = this.config.timezone?.trim();
    if (timezone) {
      try {
        effectiveSystemPrompt += '\n\n' + formatTimeContextBlock(timezone, new Date());
      } catch (err) {
        logger.error({ err, agentId, timezone }, 'formatTimeContextBlock failed — time context not injected; check TIMEZONE config');
      }
    }

    // Append intent anchor — present only for persistent scheduler tasks that have a
    // linked agent_task record. Injected last so it sits closest to the conversation,
    // making it maximally salient. It is non-negotiable: the agent may evolve its
    // approach across bursts, but cannot abandon the original mandate.
    if (taskEvent.payload.intentAnchor) {
      effectiveSystemPrompt += '\n\n## Original Task Intent\n' + taskEvent.payload.intentAnchor;
    }
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor test -- tests/unit/agents/runtime.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 5: Run the full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor add src/agents/runtime.ts tests/unit/agents/runtime.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor commit -m "feat: inject intent anchor into effectiveSystemPrompt at burst start"
```

---

### Task 4: Add coordinator guidance on intent anchors

**Files:**
- Modify: `agents/coordinator.yaml`

No tests — this is behavioral guidance in a YAML config.

- [ ] **Step 1: Add the scheduling section**

In `agents/coordinator.yaml`, find the `## Research` section heading (around line 165). Insert a new `## Scheduled Tasks` section immediately before it:

```yaml
  ## Scheduled Tasks
  When the CEO asks you to set up a recurring task (e.g. "check X every week",
  "remind me every Monday"), use scheduler-create with a cron_expr.

  **Always provide intent_anchor for recurring (cron_expr) jobs.** Write one or
  two sentences describing what the task is meant to accomplish and why — the
  original mandate. This is the anchor that prevents drift across multiple
  executions.

  Rules for writing a good intent_anchor:
  - Describe *intent*, not *implementation*: what should be achieved, not which
    tools to call
  - Good: "Run weekly contacts dedup scan and present any probable/certain
    duplicate pairs to Joseph for review."
  - Bad: "Call contact-find-duplicates with min_confidence probable then loop
    through pairs calling contact-merge dry_run: true."

  **Do NOT provide intent_anchor for one-shot (run_at) jobs.** A one-shot job
  fires once and is done — there is no multi-burst drift risk.

  **The anchor should be stable.** If the CEO fundamentally changes what a
  recurring task should do, cancel the old job and create a new one with a
  fresh anchor. Do not treat it as an update to the existing job.

```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor add agents/coordinator.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor commit -m "feat: add coordinator guidance for intent_anchor on recurring jobs"
```

---

### Task 5: Changelog and version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Update CHANGELOG.md**

Under `## [Unreleased]`, add an `### Added` section (or append to it if one already exists):

```markdown
### Added
- **Intent anchor** — `intentAnchor` field on `AgentTaskEvent` payload; the scheduler
  passes the anchor from `agent_tasks.intent_anchor` through the event, and the runtime
  injects a `## Original Task Intent` block into `effectiveSystemPrompt` on every burst
  for persistent tasks. Prevents multi-burst drift (spec 01). Coordinator YAML updated
  with guidance on when and how to provide `intent_anchor` to `scheduler-create`.
```

Note: `AgentTaskEvent` payload is a public API surface — this additive change must be
called out. The bump is still patch because the field is optional and the change is
backward-compatible.

- [ ] **Step 2: Bump version in `package.json`**

Change `"version": "0.14.2"` → `"version": "0.14.3"`.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor add CHANGELOG.md package.json
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-intent-anchor commit -m "chore: bump to 0.14.3, changelog for intent anchor"
```
