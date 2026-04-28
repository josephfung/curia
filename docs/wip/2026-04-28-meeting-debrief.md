# Meeting Debrief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a proactive meeting-debrief agent that detects ended meetings, prompts the CEO for takeaways via Signal, and executes follow-up actions.

**Architecture:** New `meeting-debrief` specialist agent triggered by a 5-minute cron job. Uses a new "conversation claims" primitive (Postgres-backed registry in the dispatcher) so that CEO responses on Signal route back to the debrief agent instead of the coordinator. State persists between cron ticks via `scheduler-report` context. Cross-specialist work goes through the Bullpen.

**Tech Stack:** TypeScript/ESM, PostgreSQL, Vitest, Nylas Calendar SDK, pino logging

**Spec:** `docs/specs/17-meeting-debrief.md`

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `src/db/migrations/NNN_create_conversation_claims.sql` | Postgres table for durable claims (next available number after rebase — verify with `ls src/db/migrations/ \| sort`) |
| `src/dispatch/conversation-claims.ts` | ConversationClaimRegistry class (CRUD + expiry) |
| `src/dispatch/conversation-claims.test.ts` | Unit tests for claim registry |
| `skills/claim-conversation/skill.json` | Manifest for claim/release skill |
| `skills/claim-conversation/handler.ts` | Skill handler |
| `skills/claim-conversation/handler.test.ts` | Tests |
| `skills/debrief-status/skill.json` | Manifest for status query skill |
| `skills/debrief-status/handler.ts` | Skill handler |
| `skills/debrief-status/handler.test.ts` | Tests |
| `agents/meeting-debrief.yaml` | Agent config (prompt, skills, schedule) |
| `docs/adr/017-conversation-claims.md` | ADR for the conversation claims pattern |

### Modified files
| File | Change |
|---|---|
| `src/dispatch/dispatcher.ts` | Check claims before coordinator routing (~15 lines) |
| `config/default.yaml` | Add `debrief:` top-level config block |
| `src/bus/events.ts` | (Only if needed — may not need new event types) |
| `docs/adr/README.md` | Add ADR-017 entry |
| `CHANGELOG.md` | Add entries under [Unreleased] |

---

## Task 1: Conversation Claims — DB Migration

**Files:**
- Create: `src/db/migrations/NNN_create_conversation_claims.sql` (verify next available number with `ls src/db/migrations/ | sort`)

- [ ] **Step 1: Write the migration**

```sql
-- NNN_create_conversation_claims.sql
--
-- Conversation claims allow specialist agents to own user-facing
-- conversation threads for proactive communication patterns.
-- See ADR-017 and docs/specs/17-meeting-debrief.md.

CREATE TABLE conversation_claims (
  conversation_id  TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  claimed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  metadata         JSONB
);

CREATE INDEX idx_conversation_claims_expires
  ON conversation_claims (expires_at);

CREATE INDEX idx_conversation_claims_agent
  ON conversation_claims (agent_id);
```

- [ ] **Step 2: Verify migration number is unique**

Run: `ls src/db/migrations/ | sort`
Expected: No duplicate `029` prefix. If one exists (from a concurrent branch), renumber to the next available slot.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/029_create_conversation_claims.sql
git commit -m "feat: add conversation_claims migration (ADR-017)"
```

---

## Task 2: Conversation Claims — Registry Implementation

**Files:**
- Create: `src/dispatch/conversation-claims.ts`
- Create: `src/dispatch/conversation-claims.test.ts`

- [ ] **Step 1: Write the failing test — claim and check**

```typescript
// src/dispatch/conversation-claims.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationClaimRegistry } from './conversation-claims.js';
import { getTestPool, cleanupTestPool } from '../../tests/helpers/db.js';
import type { Pool } from 'pg';

describe('ConversationClaimRegistry', () => {
  let pool: Pool;
  let registry: ConversationClaimRegistry;

  beforeEach(async () => {
    pool = await getTestPool();
    registry = new ConversationClaimRegistry(pool);
  });

  afterEach(async () => {
    await pool.query('DELETE FROM conversation_claims');
    await cleanupTestPool();
  });

  it('claims a conversation and resolves the owning agent', async () => {
    await registry.claim('conv:123', 'meeting-debrief', { meetingId: 'abc' });
    const owner = await registry.getOwner('conv:123');
    expect(owner).toBe('meeting-debrief');
  });

  it('returns null for unclaimed conversations', async () => {
    const owner = await registry.getOwner('conv:unknown');
    expect(owner).toBeNull();
  });

  it('releases a claim', async () => {
    await registry.claim('conv:123', 'meeting-debrief');
    await registry.release('conv:123');
    const owner = await registry.getOwner('conv:123');
    expect(owner).toBeNull();
  });

  it('ignores expired claims', async () => {
    // Insert an already-expired claim directly
    await pool.query(
      `INSERT INTO conversation_claims (conversation_id, agent_id, expires_at)
       VALUES ($1, $2, now() - interval '1 hour')`,
      ['conv:expired', 'meeting-debrief'],
    );
    const owner = await registry.getOwner('conv:expired');
    expect(owner).toBeNull();
  });

  it('replaces an existing claim by the same agent', async () => {
    await registry.claim('conv:123', 'meeting-debrief', { v: 1 });
    await registry.claim('conv:123', 'meeting-debrief', { v: 2 });
    const owner = await registry.getOwner('conv:123');
    expect(owner).toBe('meeting-debrief');
  });

  it('rejects claim if conversation is owned by a different agent', async () => {
    await registry.claim('conv:123', 'agent-a');
    await expect(registry.claim('conv:123', 'agent-b'))
      .rejects.toThrow(/already claimed/);
  });

  it('cleans up expired claims', async () => {
    await pool.query(
      `INSERT INTO conversation_claims (conversation_id, agent_id, expires_at)
       VALUES ($1, $2, now() - interval '1 hour')`,
      ['conv:old', 'meeting-debrief'],
    );
    const removed = await registry.cleanupExpired();
    expect(removed).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix . test -- src/dispatch/conversation-claims.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ConversationClaimRegistry**

```typescript
// src/dispatch/conversation-claims.ts
import type { Pool } from 'pg';

const DEFAULT_TTL_HOURS = 48;

export class ConversationClaimRegistry {
  constructor(private readonly pool: Pool) {}

  /**
   * Claim a conversation for an agent. Fails if already claimed by a
   * different agent. Replaces existing claims by the same agent (upsert).
   */
  async claim(
    conversationId: string,
    agentId: string,
    metadata?: Record<string, unknown>,
    ttlHours: number = DEFAULT_TTL_HOURS,
  ): Promise<void> {
    // Check for existing non-expired claim by a different agent
    const existing = await this.pool.query(
      `SELECT agent_id FROM conversation_claims
       WHERE conversation_id = $1 AND expires_at > now()`,
      [conversationId],
    );

    if (existing.rows.length > 0 && existing.rows[0].agent_id !== agentId) {
      throw new Error(
        `Conversation ${conversationId} already claimed by ${existing.rows[0].agent_id}`,
      );
    }

    await this.pool.query(
      `INSERT INTO conversation_claims (conversation_id, agent_id, expires_at, metadata)
       VALUES ($1, $2, now() + make_interval(hours => $3), $4)
       ON CONFLICT (conversation_id) DO UPDATE
         SET agent_id = EXCLUDED.agent_id,
             expires_at = EXCLUDED.expires_at,
             metadata = EXCLUDED.metadata,
             claimed_at = now()`,
      [conversationId, agentId, ttlHours, metadata ? JSON.stringify(metadata) : null],
    );
  }

  /**
   * Return the owning agent ID if the conversation has a non-expired claim.
   * Returns null for unclaimed or expired conversations.
   */
  async getOwner(conversationId: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT agent_id FROM conversation_claims
       WHERE conversation_id = $1 AND expires_at > now()`,
      [conversationId],
    );
    return result.rows[0]?.agent_id ?? null;
  }

  /** Release a claim (agent is done with the conversation). */
  async release(conversationId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM conversation_claims WHERE conversation_id = $1',
      [conversationId],
    );
  }

  /** Remove all expired claims. Returns the count of rows deleted. */
  async cleanupExpired(): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM conversation_claims WHERE expires_at <= now()',
    );
    return result.rowCount ?? 0;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix . test -- src/dispatch/conversation-claims.test.ts`
Expected: All 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/conversation-claims.ts src/dispatch/conversation-claims.test.ts
git commit -m "feat: add ConversationClaimRegistry (Postgres-backed)"
```

---

## Task 3: Dispatcher Integration — Claim Check Before Routing

**Files:**
- Modify: `src/dispatch/dispatcher.ts` (~line 684, where `agentId: 'coordinator'` is hardcoded)

- [ ] **Step 1: Read the dispatcher to locate the exact insertion point**

Read `src/dispatch/dispatcher.ts` around line 683-690. The key line is:
```typescript
const taskEvent = createAgentTask({
  agentId: 'coordinator',  // ← This is what we conditionally override
  ...
});
```

- [ ] **Step 2: Add ConversationClaimRegistry to Dispatcher constructor**

The Dispatcher constructor needs a new parameter. Find the constructor and add:
```typescript
private readonly claimRegistry?: ConversationClaimRegistry;
```

Add the import at the top of the file:
```typescript
import { ConversationClaimRegistry } from './conversation-claims.js';
```

Update the constructor to accept and store it. The registry is optional — when absent, all routing goes to coordinator as before (backward compatible).

- [ ] **Step 3: Add claim check before task creation**

Before the `createAgentTask` call (around line 683), add:
```typescript
// Check if a specialist agent has claimed this conversation (ADR-017)
let targetAgentId = 'coordinator';
if (this.claimRegistry) {
  const claimedBy = await this.claimRegistry.getOwner(payload.conversationId);
  if (claimedBy) {
    targetAgentId = claimedBy;
    this.logger.info(
      { conversationId: payload.conversationId, claimedBy },
      'Routing to claimed agent',
    );
  }
}
```

Then change `agentId: 'coordinator'` to `agentId: targetAgentId`.

- [ ] **Step 4: Wire the registry in the bootstrap (src/index.ts)**

Find where the Dispatcher is instantiated in `src/index.ts`. Pass the `ConversationClaimRegistry` as a new constructor argument. Instantiate the registry with the existing `pool`.

- [ ] **Step 5: Run the existing dispatcher tests**

Run: `npm --prefix . test -- src/dispatch/dispatcher`
Expected: All existing tests pass (backward compatible — no claims means coordinator routing)

- [ ] **Step 6: Add a dispatcher test for claim routing**

Add a test in the appropriate dispatcher test file that:
1. Creates a claim for conversation `test:conv:1` → agent `meeting-debrief`
2. Sends an inbound message with `conversationId: 'test:conv:1'`
3. Asserts the resulting `agent.task` event targets `meeting-debrief` instead of `coordinator`

- [ ] **Step 7: Run tests**

Run: `npm --prefix . test -- src/dispatch/`
Expected: All tests pass including the new claim routing test

- [ ] **Step 8: Commit**

```bash
git add src/dispatch/dispatcher.ts src/index.ts [test file]
git commit -m "feat: dispatcher checks conversation claims before routing (ADR-017)"
```

---

## Task 4: claim-conversation Skill

**Files:**
- Create: `skills/claim-conversation/skill.json`
- Create: `skills/claim-conversation/handler.ts`
- Create: `skills/claim-conversation/handler.test.ts`

- [ ] **Step 1: Write the skill manifest**

```json
{
  "name": "claim-conversation",
  "description": "Claim or release ownership of a conversation thread. Used by agents that initiate proactive conversations and need responses routed back to them instead of the coordinator. See ADR-017.",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "action_risk": "low",
  "inputs": {
    "action": { "type": "string", "description": "Either 'claim' or 'release'" },
    "conversationId": { "type": "string", "description": "The conversation ID to claim or release" },
    "metadata": { "type": "object", "description": "Optional metadata to store with the claim (e.g. meeting ID)" },
    "ttlHours": { "type": "number", "description": "Optional TTL in hours (default: 48)" }
  },
  "outputs": {
    "success": { "type": "boolean" }
  },
  "permissions": [],
  "secrets": [],
  "timeout": 5000,
  "capabilities": ["claimRegistry"]
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// skills/claim-conversation/handler.test.ts
import { describe, it, expect } from 'vitest';
import { ClaimConversationHandler } from './handler.js';
import type { SkillContext, SkillResult } from '../../src/skills/types.js';

// Minimal mock context factory
function mockCtx(input: Record<string, unknown>, claimRegistry?: unknown): SkillContext {
  return {
    input,
    secret: () => '',
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    agentId: 'meeting-debrief',
    claimRegistry: claimRegistry as any,
  } as unknown as SkillContext;
}

describe('ClaimConversationHandler', () => {
  const handler = new ClaimConversationHandler();

  it('fails without claimRegistry capability', async () => {
    const result = await handler.execute(mockCtx({ action: 'claim', conversationId: 'x' }));
    expect(result.success).toBe(false);
    expect((result as any).error).toMatch(/claimRegistry/);
  });

  it('fails without action', async () => {
    const result = await handler.execute(mockCtx({ conversationId: 'x' }, {}));
    expect(result.success).toBe(false);
  });

  it('fails without conversationId', async () => {
    const result = await handler.execute(mockCtx({ action: 'claim' }, {}));
    expect(result.success).toBe(false);
  });

  it('calls registry.claim for claim action', async () => {
    let called = false;
    const mockRegistry = {
      claim: async () => { called = true; },
    };
    const result = await handler.execute(
      mockCtx({ action: 'claim', conversationId: 'conv:1' }, mockRegistry),
    );
    expect(result.success).toBe(true);
    expect(called).toBe(true);
  });

  it('calls registry.release for release action', async () => {
    let called = false;
    const mockRegistry = {
      release: async () => { called = true; },
    };
    const result = await handler.execute(
      mockCtx({ action: 'release', conversationId: 'conv:1' }, mockRegistry),
    );
    expect(result.success).toBe(true);
    expect(called).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm --prefix . test -- skills/claim-conversation/handler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement the handler**

```typescript
// skills/claim-conversation/handler.ts
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ClaimConversationHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.claimRegistry) {
      return {
        success: false,
        error: 'claim-conversation requires claimRegistry in context. Declare "claimRegistry" in capabilities.',
      };
    }

    const { action, conversationId, metadata, ttlHours } = ctx.input as {
      action?: string;
      conversationId?: string;
      metadata?: Record<string, unknown>;
      ttlHours?: number;
    };

    if (!action || (action !== 'claim' && action !== 'release')) {
      return { success: false, error: 'Missing or invalid input: action (must be "claim" or "release")' };
    }
    if (!conversationId || typeof conversationId !== 'string') {
      return { success: false, error: 'Missing required input: conversationId (string)' };
    }

    try {
      if (action === 'claim') {
        await ctx.claimRegistry.claim(
          conversationId,
          ctx.agentId ?? 'unknown',
          metadata,
          ttlHours,
        );
        ctx.log.info({ conversationId, agentId: ctx.agentId }, 'Conversation claimed');
      } else {
        await ctx.claimRegistry.release(conversationId);
        ctx.log.info({ conversationId }, 'Conversation claim released');
      }
      return { success: true, data: { action, conversationId } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, conversationId }, 'claim-conversation failed');
      return { success: false, error: message };
    }
  }
}
```

- [ ] **Step 5: Add `claimRegistry` to SkillContext interface**

In `src/skills/types.ts`, add to the SkillContext interface (alongside other capability-gated services):
```typescript
/** Conversation claim registry — declare "claimRegistry" in capabilities */
claimRegistry?: ConversationClaimRegistry;
```

Add the import:
```typescript
import type { ConversationClaimRegistry } from '../dispatch/conversation-claims.js';
```

- [ ] **Step 6: Wire claimRegistry into SkillContext builder**

In the execution layer where SkillContext is assembled (likely `src/skills/skill-runner.ts` or similar), pass the `claimRegistry` when the skill declares it in `capabilities`. Follow the same pattern used for `schedulerService`, `outboundGateway`, etc.

- [ ] **Step 7: Run tests**

Run: `npm --prefix . test -- skills/claim-conversation/handler.test.ts`
Expected: All 5 tests pass

- [ ] **Step 8: Commit**

```bash
git add skills/claim-conversation/ src/skills/types.ts [skill-runner changes]
git commit -m "feat: add claim-conversation skill"
```

---

## Task 5: ADR-017 — Conversation Claims

**Files:**
- Create: `docs/adr/017-conversation-claims.md`
- Modify: `docs/adr/README.md`

- [ ] **Step 1: Read the ADR template**

Read `docs/adr/template.md` for the exact format.

- [ ] **Step 2: Write ADR-017**

Follow the Nygard-style format. Key content from the spec:

**Title:** ADR-017: Conversation Claims for Proactive Agent Communication

**Context:** Specialist agents that initiate proactive conversations (meeting debriefs, reminders, relationship check-ins) need responses routed back to them, not the coordinator. The current dispatcher hardcodes all inbound routing to the coordinator. In-process state was rejected because regular deployments would lose claims mid-conversation.

**Decision:** A conversation claim registry backed by Postgres, with a `claim-conversation` skill and TTL-based expiry. Claims are checked before default routing. The `claim-conversation` skill keeps claims intentional and auditable — the OutboundGateway does not auto-claim.

**Consequences:** Enables proactive agent patterns. Backward compatible. Coordinator persona stays unified. Future proactive agents get the same infrastructure. Adds one Postgres table and one DB query per inbound message (mitigated by short-lived cache if needed).

- [ ] **Step 3: Add entry to docs/adr/README.md**

Add a row: `| 017 | Conversation Claims for Proactive Agent Communication | Accepted | 2026-04-28 |`

- [ ] **Step 4: Commit**

```bash
git add docs/adr/017-conversation-claims.md docs/adr/README.md
git commit -m "docs: add ADR-017 — conversation claims"
```

---

## Task 6: Debrief Config Block

**Files:**
- Modify: `config/default.yaml`

- [ ] **Step 1: Read config/default.yaml to find the right insertion point**

Add the `debrief:` block at the top level, alongside existing blocks like `channels:`, `dispatch:`, `security:`.

- [ ] **Step 2: Add the debrief config block**

```yaml
# Meeting debrief — proactive post-meeting follow-up (spec 17)
debrief:
  enabled: true
  channel: signal
  pollIntervalCron: "*/5 * * * *"
  internalDomains:
    - josephfung.ca
  reminderDelayMinutes: 120
  scanWindowMinutes: 7
  claimTtlHours: 48
```

- [ ] **Step 3: Add config validation**

If the project uses Ajv schema validation at startup (startup validator), add a schema for the `debrief` block. Check `src/startup/` for the existing validation pattern and add the debrief schema alongside existing schemas.

- [ ] **Step 4: Run tests**

Run: `npm --prefix . test`
Expected: All existing tests pass (config addition is additive)

- [ ] **Step 5: Commit**

```bash
git add config/default.yaml [validation files if changed]
git commit -m "feat: add debrief config block"
```

---

## Task 7: Meeting-Debrief Agent YAML Config

**Files:**
- Create: `agents/meeting-debrief.yaml`

- [ ] **Step 1: Read agents/research-analyst.yaml for the specialist pattern**

Read the file to confirm the exact structure: name, role, description, model, system_prompt, pinned_skills, allow_discovery, memory.

- [ ] **Step 2: Write the agent YAML**

```yaml
name: meeting-debrief
role: specialist
description: >-
  Proactively prompts the CEO for meeting takeaways after meetings end,
  then executes follow-up actions: drafting emails, booking meetings,
  tracking commitments, research, and anything else the CEO's notes
  imply. Uses LLM judgment to decide which meetings warrant a debrief.
model:
  provider: anthropic
  model: claude-sonnet-4-6
schedule:
  - cron: "*/5 * * * *"
    task: "Check for recently-ended meetings that may warrant follow-up"
    expectedDurationSeconds: 120
system_prompt: |
  You are the meeting-debrief specialist. Your job is to help the CEO
  stay on top of meeting follow-ups without adding overhead.

  ## Your Workflow

  ### When triggered by the scheduler (detection mode):
  1. Check the calendar for meetings that ended recently.
  2. For each candidate meeting, decide: does this warrant a debrief?
     - Most meetings with external participants: YES
     - Key internal meetings (board debriefs, crisis comms, strategy): YES
     - Personal appointments, routine social check-ins: NO
     - Check entity context for any stored preferences about specific contacts
  3. If YES, send a brief, conversational debrief prompt to the CEO.
  4. Track the debrief state using scheduler-report.

  ### When the CEO responds (debrief mode):
  1. Parse the CEO's raw notes in context of the meeting and attendees.
  2. Execute follow-up actions using your full skill set. Default to drafts
     for emails — only send directly if the CEO explicitly says "send."
  3. Confirm what you're doing on the same thread. Keep it brief.
  4. Store any durable knowledge (commitments, preferences) in the KG.

  ## Debrief Prompt Style
  Conversational, brief, efficient. One or two sentences max.
  Name the attendees. Don't assume what kind of follow-up is needed.
  Example: "You just wrapped up with Sarah Chen and David Park from
  Meridian. Any takeaways or follow-ups?"

  ## Internal vs. External
  Internal domains are configured in the debrief config. Any attendee
  email not matching those domains is external. But your judgment should
  consider the full context — some internal meetings warrant debriefs,
  some external meetings don't.

  ## State Management
  Use scheduler-report at the end of each run to persist your state:
  - pendingDebriefs: meetings you've prompted about, keyed by event ID
  - judgedEvents: meetings you've already judged (YES/NO/DEFER)
  - lastScanTimestamp: when you last checked the calendar

  ## Cross-Specialist Work
  For tasks that need other specialists (e.g., research), post a Bullpen
  discussion thread mentioning the relevant agent. Don't try to do
  everything yourself.
pinned_skills:
  - calendar-list-events
  - calendar-create-event
  - calendar-check-conflicts
  - calendar-find-free-time
  - email-send
  - email-draft-save
  - claim-conversation
  - debrief-status
  - scheduler-create
  - scheduler-list
  - scheduler-cancel
  - scheduler-report
  - entity-lookup
  - entity-context
  - contact-lookup
  - memory-store
  - memory-recall
allow_discovery: false
memory:
  scopes: [debrief]
```

- [ ] **Step 3: Verify the agent loads at startup**

Run: `npm --prefix . run build` (or typecheck)
Expected: No errors — the agent YAML is valid and all referenced skills exist (except `debrief-status` which we'll create in Task 9)

- [ ] **Step 4: Commit**

```bash
git add agents/meeting-debrief.yaml
git commit -m "feat: add meeting-debrief agent YAML config"
```

---

## Task 8: Prompt Delivery — Outbound via Configured Channel

This task implements the core detection-and-prompt loop. The agent's system prompt (Task 7) guides the LLM's behavior; this task ensures the mechanical pieces work: reading calendar, classifying attendees, sending outbound, claiming the conversation, and persisting state.

**Files:**
- The meeting-debrief agent's behavior is driven by its YAML prompt + skills. No new handler code is needed for the detection pipeline — the LLM orchestrates skills.
- However, we need to verify the outbound path works for proactive Signal messages.

- [ ] **Step 1: Verify the OutboundGateway can send proactive Signal messages**

Read `src/skills/outbound-gateway.ts` to confirm the `send()` method for Signal:
```typescript
{ channel: 'signal', recipient: '+14155552671', message: 'text' }
```
The CEO's phone number must be resolvable. Check how the coordinator sends Signal messages — likely via the contact system's connected accounts.

- [ ] **Step 2: Write an integration test for the debrief detection flow**

Create a test that:
1. Sets up a mock calendar response with a recently-ended meeting (external attendees)
2. Fires the scheduler cron for the meeting-debrief agent
3. Verifies the agent calls `calendar-list-events`
4. Verifies the agent sends an outbound message via the configured channel
5. Verifies the agent calls `claim-conversation` to claim the response thread
6. Verifies the agent calls `scheduler-report` to persist state

This will be a smoke test or integration test depending on how deep you want to go. At minimum, write a unit test that verifies the state management logic: given a prior-run context with `pendingDebriefs` and `judgedEvents`, new events are filtered correctly.

- [ ] **Step 3: Test the outbound path manually**

Start the dev server with real calendar data and Signal channel. Verify:
- The cron fires every 5 minutes
- The agent detects a recently-ended meeting
- A Signal message is sent to the CEO
- The conversation claim is registered in Postgres

- [ ] **Step 4: Commit any test files**

```bash
git add [test files]
git commit -m "test: add debrief detection flow tests"
```

---

## Task 9: debrief-status Skill

**Files:**
- Create: `skills/debrief-status/skill.json`
- Create: `skills/debrief-status/handler.ts`
- Create: `skills/debrief-status/handler.test.ts`

- [ ] **Step 1: Write the skill manifest**

```json
{
  "name": "debrief-status",
  "description": "Query the meeting-debrief agent's current state: pending debriefs, recently completed follow-ups, and deferred meetings. Used by the coordinator to answer CEO questions like 'what meetings still need follow-up?'",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "inputs": {
    "query": { "type": "string", "description": "Optional filter: 'pending', 'completed', 'deferred', or 'all' (default: 'all')" }
  },
  "outputs": {
    "debriefs": { "type": "array", "description": "List of debrief records matching the query" }
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000,
  "capabilities": ["schedulerService", "entityMemory"]
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// skills/debrief-status/handler.test.ts
import { describe, it, expect } from 'vitest';
import { DebriefStatusHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function mockCtx(input: Record<string, unknown>, schedulerService?: unknown): SkillContext {
  return {
    input,
    secret: () => '',
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    schedulerService: schedulerService as any,
    entityMemory: { findEdges: async () => [] } as any,
  } as unknown as SkillContext;
}

describe('DebriefStatusHandler', () => {
  const handler = new DebriefStatusHandler();

  it('fails without schedulerService', async () => {
    const result = await handler.execute(mockCtx({}));
    expect(result.success).toBe(false);
  });

  it('returns empty when no debriefs exist', async () => {
    const mockScheduler = {
      getJobsByAgent: async () => [],
    };
    const result = await handler.execute(mockCtx({ query: 'all' }, mockScheduler));
    expect(result.success).toBe(true);
    expect((result as any).data.debriefs).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm --prefix . test -- skills/debrief-status/handler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement the handler**

The handler reads the meeting-debrief agent's `last_run_context` from the scheduler to find pending debriefs. For historical data, it queries KG facts. The exact implementation depends on how `schedulerService` exposes job data — read the interface to determine available methods.

```typescript
// skills/debrief-status/handler.ts
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class DebriefStatusHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.schedulerService) {
      return {
        success: false,
        error: 'debrief-status requires schedulerService in context.',
      };
    }

    const query = (ctx.input as { query?: string }).query ?? 'all';

    try {
      // Get the meeting-debrief agent's scheduled jobs to read last_run_context
      const jobs = await ctx.schedulerService.getJobsByAgent('meeting-debrief');
      const cronJob = jobs.find((j: any) => j.cronExpr);

      if (!cronJob?.lastRunContext) {
        return { success: true, data: { debriefs: [], message: 'No debrief data available yet.' } };
      }

      const context = typeof cronJob.lastRunContext === 'string'
        ? JSON.parse(cronJob.lastRunContext)
        : cronJob.lastRunContext;

      const pendingDebriefs = context.pendingDebriefs ?? {};
      const judgedEvents = context.judgedEvents ?? {};

      const debriefs: unknown[] = [];

      if (query === 'all' || query === 'pending') {
        for (const [eventId, info] of Object.entries(pendingDebriefs)) {
          debriefs.push({ eventId, status: 'pending', ...(info as object) });
        }
      }

      if (query === 'all' || query === 'deferred') {
        for (const [eventId, info] of Object.entries(judgedEvents)) {
          if ((info as any).judgment === 'defer') {
            debriefs.push({ eventId, status: 'deferred', ...(info as object) });
          }
        }
      }

      // For completed debriefs (historical), query KG facts
      // This is a stretch goal — KG query for "debrief completed" facts
      // on contact/org entities. For now, return what's in the scheduler state.

      return { success: true, data: { debriefs, query } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'debrief-status failed');
      return { success: false, error: message };
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm --prefix . test -- skills/debrief-status/handler.test.ts`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add skills/debrief-status/
git commit -m "feat: add debrief-status skill"
```

---

## Task 10: CHANGELOG and Final Integration

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entries under [Unreleased]**

```markdown
### Added
- **Meeting debrief agent** — proactive post-meeting follow-up: detects ended meetings,
  prompts CEO for takeaways via Signal, executes follow-up actions (spec 17)
- **Conversation claims (ADR-017)** — Postgres-backed registry enabling specialist agents
  to own user-facing conversation threads for proactive communication patterns
- **claim-conversation skill** — agents can claim/release conversation threads
- **debrief-status skill** — coordinator can query pending/completed/deferred debriefs
- **debrief config block** — top-level config for debrief channel, polling, internal domains
```

- [ ] **Step 2: Run full test suite**

Run: `npm --prefix . test`
Expected: All tests pass, no regressions

- [ ] **Step 3: Run typecheck**

Run: `npm --prefix . run build` (or `tsc --noEmit` if available)
Expected: Clean — no type errors

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add meeting debrief changelog entries"
```

- [ ] **Step 5: Manual testing checklist**

Run the dev server with real calendar and Signal:
- [ ] Cron fires every 5 minutes
- [ ] Agent detects a recently-ended meeting with external attendees
- [ ] LLM judgment correctly identifies debrief-worthy meetings
- [ ] Signal message sent to CEO with correct attendee names
- [ ] Conversation claim appears in `conversation_claims` table
- [ ] CEO's Signal response routes to meeting-debrief agent (not coordinator)
- [ ] Agent processes notes and drafts follow-up email
- [ ] Confirmation message sent back on same Signal thread
- [ ] Reminder fires if CEO doesn't respond within configured window
- [ ] `debrief-status` skill returns pending debriefs when coordinator asks
- [ ] Claims survive a server restart
- [ ] Agent correctly skips meetings it already judged (NO/DEFER)
- [ ] Agent correctly skips meetings it already prompted for

---

## Notes for the Implementer

### State persistence pattern
The meeting-debrief agent persists state between cron runs using `scheduler-report`. At the end of each run, call the skill with:
- `job_id`: the cron job's ID (injected in the task content)
- `summary`: human-readable description of what happened this run
- `context`: JSON object with `pendingDebriefs`, `judgedEvents`, `lastScanTimestamp`

On the next run, the scheduler injects the prior run's context into the task content via `buildPriorRunBlock()`. The agent reads this to know its state.

### OutboundGateway for Signal
To send a proactive Signal message:
```typescript
await outboundGateway.send({
  channel: 'signal',
  recipient: ceoPhoneNumber,  // E.164 format from contact system
  message: 'Your debrief prompt text here',
});
```

### Internal domain classification
```typescript
const internalDomains = config.debrief.internalDomains; // ['josephfung.ca']
const isExternal = (email: string) =>
  !internalDomains.some(d => email.toLowerCase().endsWith(`@${d}`));
```

### Conversation ID for Signal
Signal conversation IDs follow the pattern `signal:<phone>:<thread>`. The agent must use this exact ID when claiming the conversation.
