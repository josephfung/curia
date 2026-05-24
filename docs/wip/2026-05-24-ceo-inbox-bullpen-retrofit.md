# CEO-Inbox Bullpen-Through-Coordinator Retrofit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove direct `signal-send` from the ceo-inbox agent and route urgent alerts through the coordinator via structured Bullpen requests with context bridge metadata.

**Architecture:** ceo-inbox posts a Bullpen thread to the coordinator with `Urgency: immediate`, desired channel/message, and context_bridge params. Coordinator receives via bullpen task, applies judgment, calls `signal-send` with context_bridge. Replies route back to ceo-inbox via delegation.

**Tech Stack:** Agent YAML prompt editing, Vitest integration test

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `agents/ceo-inbox.yaml` | Modify | Remove `signal-send` from pinned_skills, rewrite URGENT prompt sections |
| `tests/integration/ceo-inbox-bullpen-escalation.test.ts` | Create | Integration test: urgent email → bullpen → coordinator → signal-send with context_bridge |
| `CHANGELOG.md` | Modify | Add entry under `[Unreleased]` |

---

### Task 1: Remove `signal-send` from pinned_skills

**Files:**
- Modify: `agents/ceo-inbox.yaml:27`

- [ ] **Step 1: Delete the `signal-send` line from pinned_skills**

In `agents/ceo-inbox.yaml`, remove line 27 (`  - signal-send`). The list should go directly from `ceo-inbox-label` (line 25... wait, let me be precise) — from `ceo-inbox-mark-read` to `bullpen`:

Before:
```yaml
pinned_skills:
  - ceo-inbox-list
  - ceo-inbox-read
  - ceo-inbox-download-attachment
  - ceo-inbox-draft-reply
  - file-parse
  - ceo-inbox-search
  - ceo-inbox-archive
  - ceo-inbox-update-folders
  - ceo-inbox-label
  - ceo-inbox-mark-read
  - config-store
  - signal-send
  - bullpen
  - entity-context
```

After:
```yaml
pinned_skills:
  - ceo-inbox-list
  - ceo-inbox-read
  - ceo-inbox-download-attachment
  - ceo-inbox-draft-reply
  - file-parse
  - ceo-inbox-search
  - ceo-inbox-archive
  - ceo-inbox-update-folders
  - ceo-inbox-label
  - ceo-inbox-mark-read
  - config-store
  - bullpen
  - entity-context
```

- [ ] **Step 2: Commit**

```bash
git -C <worktree> add agents/ceo-inbox.yaml
git -C <worktree> commit -m "chore(ceo-inbox): remove signal-send from pinned_skills

Coordinator is now the sole voice for outbound communication.
ceo-inbox will route alerts through the Bullpen instead. (#616)"
```

---

### Task 2: Remove the CEO's Signal number from the system prompt

**Files:**
- Modify: `agents/ceo-inbox.yaml:79`

- [ ] **Step 1: Delete the Signal number line**

Remove this line from the system prompt (currently line 79):
```
  The CEO's Signal number is: +15196161377
```

The coordinator owns outbound channel details; ceo-inbox no longer contacts
the CEO directly.

- [ ] **Step 2: Commit**

```bash
git -C <worktree> add agents/ceo-inbox.yaml
git -C <worktree> commit -m "chore(ceo-inbox): remove hardcoded Signal number from prompt

Coordinator owns all outbound channel details now. (#616)"
```

---

### Task 3: Rewrite URGENT classification in step 4e

**Files:**
- Modify: `agents/ceo-inbox.yaml` (system_prompt, step 4e URGENT block, ~lines 247-251)

- [ ] **Step 1: Replace the URGENT classification block**

Find the current URGENT block in step 4e:
```
  **URGENT** — time-sensitive, CEO decision required, from a known contact:
    - Open a bullpen thread mentioning the coordinator. Include: sender
      name, subject, one-sentence summary, key deadline or ask.
    - Send a Signal message to the CEO: brief alert with sender and subject.
    - Do NOT archive. Do NOT draft a reply.
```

Replace with:
```
  **URGENT** — time-sensitive, CEO decision required, from a known contact:
    - Post a Bullpen thread mentioning the coordinator with a structured
      send request. Use this exact format:

        @coordinator I'd like you to send a message to the CEO.

        Urgency: immediate
        Channel: Signal
        Message: "<sender name> — <subject>: <one-sentence summary with deadline/ask>"
        Context bridge: agent_id=ceo-inbox, expected_reply="Decision or follow-up instruction", delegation_hint="Delegate replies to ceo-inbox", expires_in_hours=24

    - Do NOT archive. Do NOT draft a reply.
```

- [ ] **Step 2: Verify the edit is syntactically valid YAML**

Run:
```bash
npx --prefix <worktree> yaml-lint agents/ceo-inbox.yaml
```

If `yaml-lint` is not available, use node to parse:
```bash
node -e "const fs=require('fs');const yaml=require('yaml');yaml.parse(fs.readFileSync('<worktree>/agents/ceo-inbox.yaml','utf8'));console.log('OK')"
```

Expected: no parse errors.

- [ ] **Step 3: Commit**

```bash
git -C <worktree> add agents/ceo-inbox.yaml
git -C <worktree> commit -m "chore(ceo-inbox): rewrite URGENT classification to use bullpen-through-coordinator

Urgent alerts now go through the coordinator via a structured Bullpen
request with Urgency: immediate and context_bridge metadata. (#616)"
```

---

### Task 4: Rewrite URGENT actions in step 4h

**Files:**
- Modify: `agents/ceo-inbox.yaml` (system_prompt, step 4h URGENT bullet, ~lines 398-400)

- [ ] **Step 1: Replace the URGENT bullet in step 4h**

Find the current step 4h URGENT actions:
```
  - **URGENT**: Open a bullpen thread mentioning the coordinator (sender,
    subject, one-sentence summary, deadline/ask). Send a Signal alert.
    Do NOT archive.
```

Replace with:
```
  - **URGENT**: Open a bullpen thread mentioning the coordinator with a
    structured send request (Urgency: immediate, Channel: Signal, Message,
    Context bridge with agent_id=ceo-inbox and delegation_hint). Do NOT
    archive.
```

- [ ] **Step 2: Commit**

```bash
git -C <worktree> add agents/ceo-inbox.yaml
git -C <worktree> commit -m "chore(ceo-inbox): update step 4h URGENT actions to match bullpen pattern

Authoritative action checklist now references the structured send request
format rather than the direct signal-send call. (#616)"
```

---

### Task 5: Add delegation-reply note to delegated mode section

**Files:**
- Modify: `agents/ceo-inbox.yaml` (system_prompt, delegated mode section, ~lines 62-65)

- [ ] **Step 1: Append a paragraph to the delegated mode section**

After line 65 (the end of the current delegated mode description), add:

```
  Note: the coordinator may delegate CEO replies that originated from an
  urgent email alert you escalated (e.g. "tell me more about that merger
  email" or "add a rule that merger emails are URGENT"). Handle these as
  standard delegated-mode requests — they flow through the same path as
  any other coordinator delegation.
```

- [ ] **Step 2: Commit**

```bash
git -C <worktree> add agents/ceo-inbox.yaml
git -C <worktree> commit -m "chore(ceo-inbox): document delegation-reply path for alert responses

Makes explicit that CEO replies to urgent alerts route back through the
standard delegated-mode handling. (#616)"
```

---

### Task 6: Write integration test

**Files:**
- Create: `tests/integration/ceo-inbox-bullpen-escalation.test.ts`

- [ ] **Step 1: Write the integration test**

This test verifies the bullpen-through-coordinator round-trip for urgent
email escalations. It tests at the BullpenService + OutboundContextService
layer (not full agent execution — that requires an LLM call).

```typescript
// tests/integration/ceo-inbox-bullpen-escalation.test.ts
//
// Integration test: validates the infrastructure path for ceo-inbox
// urgent alerts routed through bullpen-through-coordinator pattern.
// Verifies: thread creation → coordinator receives → context bridge
// entry registered → delegation hint points back to ceo-inbox.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { BullpenService } from '../../src/memory/bullpen.js';
import { OutboundContextService } from '../../src/dispatch/outbound-context.js';
import { createLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('ceo-inbox bullpen-through-coordinator escalation', () => {
  let pool: pg.Pool;
  let bullpen: BullpenService;
  let outboundContext: OutboundContextService;
  let runId: string;

  beforeAll(async () => {
    runId = randomUUID();
    pool = new Pool({ connectionString: DATABASE_URL });
    const logger = createLogger('error');
    bullpen = BullpenService.createWithPostgres(pool, logger);
    outboundContext = new OutboundContextService(pool, logger);
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM bullpen_threads WHERE topic LIKE $1`,
      [`${runId}%`],
    );
    await pool.query(
      `DELETE FROM outbound_context WHERE agent_id = $1`,
      ['ceo-inbox'],
    );
    await pool.end();
  });

  it('ceo-inbox opens a bullpen thread mentioning coordinator for urgent email', async () => {
    // Simulate: ceo-inbox posts a structured send request to coordinator
    const { thread, message } = await bullpen.openThread(
      `${runId} — Urgent email escalation: merger deadline`,
      'ceo-inbox',
      ['ceo-inbox', 'coordinator'],
      `@coordinator I'd like you to send a message to the CEO.\n\n` +
        `Urgency: immediate\n` +
        `Channel: Signal\n` +
        `Message: "Alice Chen — Merger deadline: Decision needed on terms by Friday EOD"\n` +
        `Context bridge: agent_id=ceo-inbox, expected_reply="Decision or follow-up instruction", ` +
        `delegation_hint="Delegate replies to ceo-inbox", expires_in_hours=24`,
      ['coordinator'],
    );

    expect(thread.creatorAgentId).toBe('ceo-inbox');
    expect(thread.participants).toContain('coordinator');
    expect(message.content).toContain('Urgency: immediate');
    expect(message.content).toContain('Channel: Signal');
    expect(message.content).toContain('Context bridge:');
  });

  it('coordinator registers context bridge entry after sending', async () => {
    // Simulate: coordinator processes the bullpen request and calls signal-send
    // with context_bridge params. The send skill registers the entry.
    const entry = await outboundContext.register({
      conversationId: `conv-${runId}`,
      channelId: 'signal',
      agentId: 'ceo-inbox',
      content: 'Alice Chen — Merger deadline: Decision needed on terms by Friday EOD',
      expectedReply: 'Decision or follow-up instruction',
      delegationHint: 'Delegate replies to ceo-inbox',
      metadata: { source: 'urgent-email-escalation' },
      expiresInHours: 24,
    });

    expect(entry.id).toBeDefined();
    expect(entry.agentId).toBe('ceo-inbox');
    expect(entry.delegationHint).toBe('Delegate replies to ceo-inbox');

    // Verify the entry appears in active entries for the channel
    const active = await outboundContext.getActive('signal');
    const found = active.find(e => e.id === entry.id);
    expect(found).toBeDefined();
    expect(found!.expectedReply).toBe('Decision or follow-up instruction');
  });

  it('active context entry enables delegation back to ceo-inbox', async () => {
    // Simulate: CEO replies on Signal. Dispatcher queries active entries.
    const active = await outboundContext.getActive('signal');
    const ceoInboxEntries = active.filter(e => e.agentId === 'ceo-inbox');

    // At least one entry should point back to ceo-inbox
    expect(ceoInboxEntries.length).toBeGreaterThan(0);

    const entry = ceoInboxEntries[0]!;
    expect(entry.delegationHint).toContain('ceo-inbox');

    // Coordinator uses this hint to delegate the reply back to ceo-inbox
    // (actual delegation is tested in dispatcher-context-bridging.test.ts)
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run:
```bash
npx --prefix <worktree> vitest run tests/integration/ceo-inbox-bullpen-escalation.test.ts
```

Expected: all 3 tests pass (requires DATABASE_URL to be set; skips otherwise).

- [ ] **Step 3: Commit**

```bash
git -C <worktree> add tests/integration/ceo-inbox-bullpen-escalation.test.ts
git -C <worktree> commit -m "test: add integration test for ceo-inbox bullpen escalation path

Validates the bullpen-through-coordinator infrastructure for urgent email
alerts: thread creation, context bridge registration, and delegation hint
pointing back to ceo-inbox. (#616)"
```

---

### Task 7: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entry under `[Unreleased]` → `Changed`**

Add a `### Changed` section (or append to it if it already exists) under
`## [Unreleased]`:

```markdown
### Changed

- **`ceo-inbox`** — urgent email alerts now route through the coordinator via Bullpen instead of calling `signal-send` directly; enables context bridge delegation for CEO replies. (#616)
```

- [ ] **Step 2: Commit**

```bash
git -C <worktree> add CHANGELOG.md
git -C <worktree> commit -m "chore: add changelog entry for ceo-inbox bullpen retrofit (#616)"
```

---

### Task 8: Typecheck and final verification

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck**

```bash
pnpm --prefix <worktree> run typecheck
```

Expected: no errors (this PR is prompt-only + one new test file).

- [ ] **Step 2: Run the full test suite**

```bash
pnpm --prefix <worktree> test
```

Expected: all tests pass, including the new integration test.

- [ ] **Step 3: Verify signal-send is fully removed from ceo-inbox**

```bash
grep -n "signal-send" <worktree>/agents/ceo-inbox.yaml
```

Expected: no output (zero matches).

```bash
grep -n "Signal number" <worktree>/agents/ceo-inbox.yaml
```

Expected: no output (zero matches).

- [ ] **Step 4: Verify bullpen is still pinned**

```bash
grep -n "bullpen" <worktree>/agents/ceo-inbox.yaml
```

Expected: at least one match showing `- bullpen` in pinned_skills.
