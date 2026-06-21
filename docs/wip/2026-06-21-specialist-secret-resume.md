# Specialist Secret-Capture Resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a delegated specialist (or the setup-wizard) mints a secret-capture link, resume it on redeem by routing re-entry through the coordinator, which re-delegates via the `delegate` skill's `resume_token`.

**Architecture:** Thread the coordinator's relay routing down through `delegate` into the specialist's task metadata; the capture skills detect that context, build a `resume_token`, and retarget the capture origin at the coordinator; the redeem event re-enters the coordinator with a synthetic task telling it to re-delegate with the token. Reuses the existing #972 resume subscriber path and #984 forward guard.

**Tech Stack:** TypeScript (ESM, Node 24+), PostgreSQL (node-pg-migrate plain SQL), Vitest, pino.

**Spec:** `docs/wip/2026-06-21-specialist-secret-resume-design.md`. **Issue:** #995.

## Global Constraints

- **Worktree (WT):** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-specialist-secret-resume-995`. All commands use `pnpm -C "$WT"` / `git -C "$WT"`.
- **Run one test file:** `pnpm -C "$WT" exec vitest run <relpath>`
- **Typecheck (run before every commit touching .ts):** `pnpm -C "$WT" run typecheck`
- **ESM:** `.js` extensions on all relative imports. No `any`. No `console.log` (pino only). No empty `catch {}`.
- **SQL:** parameterized only; migrations in `src/db/migrations/` as plain SQL with `-- Up Migration` / `-- Down Migration`. Next free prefix is **061** (060 was taken upstream) — verify uniqueness with `ls src/db/migrations/ | sort` before committing.
- **No-value privacy invariant:** no secret value in any token column, event, task, or log. Tests assert the literal `hunter2` never appears.
- **Strict TS:** array access like `rows[0]` is `T | undefined` — use `!` when guaranteed; cast `Record<string,unknown>` through `unknown` after runtime validation.
- **Commits:** conventional (`feat:`/`fix:`/`chore:`), no `Co-Authored-By`, no Claude attribution.
- **CHANGELOG.md:** updated in Task 9 before the PR.

---

### Task 1: Shared resume-token helper

Extract the resume-token encode/caps logic (today inline in `runtime.ts`) into a shared module so the capture skills and the resume subscriber can produce/consume the same format.

**Files:**
- Create: `src/agents/resume-token.ts`
- Create: `src/agents/resume-token.test.ts`
- Modify: `src/agents/runtime.ts` (~lines 1006–1035, the `pendingClarification` block)

**Interfaces:**
- Produces: `encodeResumeToken({ agent: string; originalTask: string; context: string }): string`, `decodeResumeToken(token: string): ResumeTokenPayload | null`, `RESUME_TOKEN_VERSION: number`, `interface ResumeTokenPayload { v: number; agent: string; original_task: string; context: string }`, `MAX_RESUME_TASK_LENGTH`, `MAX_RESUME_CONTEXT_LENGTH`.

- [ ] **Step 1: Write the failing test**

Create `src/agents/resume-token.test.ts`:

```ts
// resume-token.test.ts — shared encode/decode for delegate resume tokens.
import { describe, it, expect } from 'vitest';
import {
  encodeResumeToken,
  decodeResumeToken,
  RESUME_TOKEN_VERSION,
  MAX_RESUME_TASK_LENGTH,
  MAX_RESUME_CONTEXT_LENGTH,
} from './resume-token.js';

describe('resume-token', () => {
  it('round-trips agent / original_task / context with the version stamp', () => {
    const token = encodeResumeToken({ agent: 'research-analyst', originalTask: 'do X', context: 'progress so far' });
    const decoded = decodeResumeToken(token);
    expect(decoded).toEqual({ v: RESUME_TOKEN_VERSION, agent: 'research-analyst', original_task: 'do X', context: 'progress so far' });
  });

  it('truncates over-budget fields with an ellipsis', () => {
    const token = encodeResumeToken({
      agent: 'a',
      originalTask: 'x'.repeat(MAX_RESUME_TASK_LENGTH + 50),
      context: 'y'.repeat(MAX_RESUME_CONTEXT_LENGTH + 50),
    });
    const decoded = decodeResumeToken(token)!;
    expect(decoded.original_task.endsWith('…')).toBe(true);
    expect(decoded.original_task.length).toBe(MAX_RESUME_TASK_LENGTH + 1);
    expect(decoded.context.endsWith('…')).toBe(true);
    expect(decoded.context.length).toBe(MAX_RESUME_CONTEXT_LENGTH + 1);
  });

  it('returns null for non-base64 / non-JSON input', () => {
    expect(decodeResumeToken('!!!not base64 json!!!')).toBeNull();
  });

  it('returns null when required string fields are missing or wrong-typed', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, agent: 'a', original_task: 'x' })).toString('base64'); // no context
    expect(decodeResumeToken(bad)).toBeNull();
    const wrongType = Buffer.from(JSON.stringify({ v: 1, agent: 5, original_task: 'x', context: 'y' })).toString('base64');
    expect(decodeResumeToken(wrongType)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C "$WT" exec vitest run src/agents/resume-token.test.ts`
Expected: FAIL — cannot find module `./resume-token.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/agents/resume-token.ts`:

```ts
// resume-token.ts — shared encode/decode for delegate resume tokens.
//
// A resume token carries the context needed to resume a paused/blocked specialist task: the
// agent, its original brief, and a progress (or intent) note. Base64-encoded so it survives
// JSON round-trips through context_bridge metadata and the secret_capture_tokens row. Versioned
// for forward-compatible format changes. Holds NO secret material — names and NL only.

/** Version marker — allows forward-compatible format changes. */
export const RESUME_TOKEN_VERSION = 1;

/** Caps on variable-length fields so the base64 token fits the 16 KB context_bridge metadata
 *  budget (8 KB raw JSON → ~10.7 KB base64). */
export const MAX_RESUME_TASK_LENGTH = 2000;
export const MAX_RESUME_CONTEXT_LENGTH = 4000;

export interface ResumeTokenPayload {
  v: number;
  agent: string;
  original_task: string;
  context: string;
}

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + '…' : value;
}

/** Build a base64 resume token, truncating over-budget fields with an ellipsis. */
export function encodeResumeToken(args: { agent: string; originalTask: string; context: string }): string {
  const payload: ResumeTokenPayload = {
    v: RESUME_TOKEN_VERSION,
    agent: args.agent,
    original_task: cap(args.originalTask, MAX_RESUME_TASK_LENGTH),
    context: cap(args.context, MAX_RESUME_CONTEXT_LENGTH),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/** Decode a resume token. Returns null (NOT throws) when the token is not valid base64 JSON with
 *  the required string fields — callers MUST handle null and log, rather than trust a malformed
 *  token. Version is not enforced here (lenient decode); callers can inspect `.v` if they care. */
export function decodeResumeToken(token: string): ResumeTokenPayload | null {
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8')) as Record<string, unknown>;
  } catch {
    // Malformed input is an expected, handled outcome (return null); not an error to propagate.
    return null;
  }
  if (
    typeof decoded.agent !== 'string' ||
    typeof decoded.original_task !== 'string' ||
    typeof decoded.context !== 'string'
  ) {
    return null;
  }
  const v = typeof decoded.v === 'number' ? decoded.v : RESUME_TOKEN_VERSION;
  // Validated above; cast through unknown per strict-TS narrowing rule.
  return { v, agent: decoded.agent, original_task: decoded.original_task, context: decoded.context } as ResumeTokenPayload;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C "$WT" exec vitest run src/agents/resume-token.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor runtime to use the helper**

In `src/agents/runtime.ts`, add the import near the other `./` imports:

```ts
import { encodeResumeToken } from './resume-token.js';
```

Replace the resume-token construction inside the `if (pendingClarification) {` block (the `const MAX_RESUME_CONTEXT_LENGTH …` through `const resumeToken = …` lines) with:

```ts
        // Construct resume_token via the shared helper so the format stays in one place
        // (consumed by the delegate skill on re-delegation). Base64-encoded, versioned, capped.
        const resumeToken = encodeResumeToken({
          agent: agentId,
          originalTask: taskEvent.payload.content,
          context: pendingClarification.context,
        });
```

Leave the `clarificationContent = JSON.stringify({ … resume_token: resumeToken })` line unchanged.

- [ ] **Step 6: Typecheck + run the runtime + helper tests**

Run: `pnpm -C "$WT" run typecheck`
Expected: no errors.
Run: `pnpm -C "$WT" exec vitest run src/agents/resume-token.test.ts src/agents/runtime.test.ts`
Expected: PASS (runtime clarification tests still green — behavior unchanged).

- [ ] **Step 7: Commit**

```bash
git -C "$WT" add src/agents/resume-token.ts src/agents/resume-token.test.ts src/agents/runtime.ts
git -C "$WT" commit -m "refactor: extract shared resume-token encode/decode helper (#995)"
```

---

### Task 2: Persist `resume_token` (migration + service round-trip)

**Files:**
- Create: `src/db/migrations/061_add_secret_capture_resume_token.sql`
- Modify: `src/secrets/secret-capture-service.ts` (`CaptureOrigin`, `CapturedContext`, `mint()` SQL, `redeem()` claim SQL + mapping)
- Modify: `src/secrets/secret-capture-service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CaptureOrigin.resumeToken?: string`, `CapturedContext.resumeToken?: string`; the `secret_capture_tokens.resume_token` column.

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/061_add_secret_capture_resume_token.sql`:

```sql
-- Up Migration
-- Specialist secret-capture resume (#995), follow-up to #972.
--
-- When a DELEGATED specialist mints a capture link, the resume must be routed through the
-- coordinator, which re-delegates to the specialist via the delegate skill's resume_token. This
-- column carries that base64 resume_token (agent + original task + progress/intent — names and NL
-- only, NEVER a secret value) so the redeem endpoint can publish it on secret.captured. Nullable:
-- a coordinator-minted link (today's only live path) leaves it NULL and resumes the agent directly.

ALTER TABLE secret_capture_tokens
  ADD COLUMN resume_token TEXT;        -- base64 delegate resume_token; NULL for coordinator-minted links

-- Down Migration

ALTER TABLE secret_capture_tokens
  DROP COLUMN resume_token;
```

- [ ] **Step 2: Verify migration prefix uniqueness**

Run: `ls "$WT"/src/db/migrations/ | sort | tail -5`
Expected: `061_add_secret_capture_resume_token.sql` is present and no other `061_*` exists.

- [ ] **Step 3: Write the failing service tests**

In `src/secrets/secret-capture-service.test.ts`, add two tests. Inside the `describe('SecretCaptureService minting …')` block:

```ts
  it('persists the resume_token on the token when supplied (#995)', async () => {
    const { svc, queries } = makeService();
    await svc.mintUserSecret({
      rawName: 'Aeroplan password',
      origin: { conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator', resumeToken: 'RESUME_TOK' },
    });
    const insert = queries.find(q => q.sql.includes('INSERT INTO secret_capture_tokens'));
    expect(insert!.sql).toContain('resume_token');
    expect(insert!.params).toContain('RESUME_TOK');
  });
```

Inside the `describe('SecretCaptureService.redeem')` block:

```ts
  it('returns the resume_token in the captured context on ok (#995)', async () => {
    const { svc } = makeService(router({
      peek: [{ value_format: 'string', spent: false }],
      claim: [{
        secret_name: 'user.aeroplan_password',
        value_format: 'string',
        label: 'Aeroplan password',
        conversation_id: 'user-conv',
        channel_id: 'email',
        agent_id: 'coordinator',
        task_event_id: null,
        originator: null,
        resume_intent: 'check the Aeroplan balance',
        resume_token: 'RESUME_TOK',
      }],
    }));
    const result = await svc.redeem('deadbeef', 'hunter2');
    expect(result).toMatchObject({ status: 'ok', captured: { resumeToken: 'RESUME_TOK' } });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm -C "$WT" exec vitest run src/secrets/secret-capture-service.test.ts`
Expected: the two new tests FAIL (resume_token not in INSERT params / not in captured context).

- [ ] **Step 5: Implement the service changes**

In `src/secrets/secret-capture-service.ts`:

Add to `interface CaptureOrigin` (after `resumeIntent?`):

```ts
  /** Base64 delegate resume_token (#995). Present only when a delegated specialist minted the
   *  link; carries no secret value. Lets the redeem endpoint thread it onto secret.captured so
   *  the coordinator can re-delegate to the specialist. */
  resumeToken?: string;
```

Add the same field to `interface CapturedContext` (after `resumeIntent?`):

```ts
  resumeToken?: string;
```

In `mint()`, update the INSERT column list, the `VALUES` placeholders, and the params array to add `resume_token` / `$12`:

```ts
    const result = await this.pool.query<{ expires_at: Date }>(
      `INSERT INTO secret_capture_tokens
         (token_hash, secret_name, label, value_format, expires_at,
          conversation_id, channel_id, agent_id, task_event_id, originator, resume_intent, resume_token)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6, $7, $8, $9, $10, $11, $12)
       RETURNING expires_at`,
      [
        tokenHash, secretName, label ?? null, valueFormat, DEFAULT_CAPTURE_TTL_MINUTES,
        origin?.conversationId ?? null,
        origin?.channelId ?? null,
        origin?.agentId ?? null,
        origin?.taskEventId ?? null,
        origin?.originator ?? null,
        origin?.resumeIntent ?? null,
        origin?.resumeToken ?? null,
      ],
    );
```

In `redeem()`, add `resume_token` to the claim query's generic type, its `RETURNING`, and the returned `captured` object:

```ts
    const claim = await this.pool.query<{
      secret_name: string;
      value_format: CaptureValueFormat;
      label: string | null;
      conversation_id: string | null;
      channel_id: string | null;
      agent_id: string | null;
      task_event_id: string | null;
      originator: Record<string, unknown> | null;
      resume_intent: string | null;
      resume_token: string | null;
    }>(
      `UPDATE secret_capture_tokens
          SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING secret_name, value_format, label,
                  conversation_id, channel_id, agent_id, task_event_id, originator, resume_intent, resume_token`,
      [tokenHash],
    );
```

And in the returned `captured` object (after `resumeIntent`):

```ts
        resumeToken: claimed.resume_token ?? undefined,
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm -C "$WT" exec vitest run src/secrets/secret-capture-service.test.ts`
Expected: PASS (incl. the two new tests; the existing `mints with NULL routing` test still passes — `>= 5` nulls now includes resume_token).
Run: `pnpm -C "$WT" run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git -C "$WT" add src/db/migrations/061_add_secret_capture_resume_token.sql src/secrets/secret-capture-service.ts src/secrets/secret-capture-service.test.ts
git -C "$WT" commit -m "feat: persist resume_token on capture tokens (#995)"
```

---

### Task 3: Carry `resumeToken` on the `secret.captured` event

**Files:**
- Modify: `src/bus/events.ts` (`SecretCapturedPayload`)
- Modify: `src/channels/http/routes/secret-capture.ts` (forward `c.resumeToken`)

**Interfaces:**
- Consumes: `CapturedContext.resumeToken` (Task 2).
- Produces: `SecretCapturedPayload.resumeToken?: string`.

- [ ] **Step 1: Add the payload field**

In `src/bus/events.ts`, add to `interface SecretCapturedPayload` (after `originator?`):

```ts
  /** Base64 delegate resume_token (#995). Present only for a delegated-specialist-minted link;
   *  carries no secret value. The resume subscriber decodes it to recover the specialist name and
   *  instructs the coordinator to re-delegate with it. */
  resumeToken?: string;
```

- [ ] **Step 2: Forward it from the endpoint**

In `src/channels/http/routes/secret-capture.ts`, inside the `createSecretCaptured({ … })` payload object, add (after `originator: c.originator,`):

```ts
                resumeToken: c.resumeToken,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -C "$WT" run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git -C "$WT" add src/bus/events.ts src/channels/http/routes/secret-capture.ts
git -C "$WT" commit -m "feat: thread resume_token onto secret.captured event (#995)"
```

---

### Task 4: `delegate` forwards the coordinator relay context

**Files:**
- Modify: `skills/delegate/handler.ts` (the `createAgentTask({ … metadata … })` call)
- Modify: `skills/delegate/skill.json` (version bump)
- Create: `skills/delegate/handler.test.ts`

**Interfaces:**
- Produces: the specialist's `agent.task` metadata now includes `delegationOrigin: { conversationId, channelId, agentId, originalTask }` (the coordinator's routing + the specialist's brief), alongside the existing `originator`.

- [ ] **Step 1: Write the failing test**

Create `skills/delegate/handler.test.ts`:

```ts
// handler.test.ts — delegate skill: forwarding of relay context for specialist resume (#995).
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { DelegateHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { BusEvent, AgentTaskEvent } from '../../src/bus/events.js';
import { createAgentResponse } from '../../src/bus/events.js';

/** Fake bus that, when an agent.task is published, immediately delivers a successful
 *  agent.response parented to it so DelegateHandler's await resolves. */
function makeBus() {
  const published: BusEvent[] = [];
  const responseHandlers: Array<(e: BusEvent) => unknown> = [];
  const bus = {
    subscribe(type: string, _layer: string, handler: (e: BusEvent) => unknown) {
      if (type === 'agent.response') responseHandlers.push(handler);
    },
    async publish(_layer: string, event: BusEvent) {
      published.push(event);
      if (event.type === 'agent.task') {
        const task = event as AgentTaskEvent;
        const resp = createAgentResponse({
          agentId: task.payload.agentId,
          conversationId: task.payload.conversationId,
          content: 'done',
          skillsCalled: [],
          parentEventId: task.id,
        });
        for (const h of responseHandlers) await h(resp);
      }
    },
  } as unknown as EventBus;
  return { bus, published };
}

const agentRegistry = {
  has: (n: string) => n === 'research-analyst',
  get: (n: string) => ({ name: n, role: 'specialist' }),
  listSpecialists: () => [{ name: 'research-analyst' }],
} as unknown as SkillContext['agentRegistry'];

function makeCtx(bus: EventBus, over: Partial<SkillContext> = {}): SkillContext {
  return {
    input: { agent: 'research-analyst', task: 'find the acquisition comps' },
    log: pino({ level: 'silent' }),
    bus,
    agentRegistry,
    agentId: 'coordinator',
    conversationId: 'user-conv',
    channelId: 'email',
    taskMetadata: { originator: { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' } },
    ...over,
  } as unknown as SkillContext;
}

describe('DelegateHandler relay-context forwarding (#995)', () => {
  it('forwards delegationOrigin (coordinator routing + brief) and originator on the specialist task', async () => {
    const { bus, published } = makeBus();
    const result = await new DelegateHandler().execute(makeCtx(bus));
    expect(result.success).toBe(true);

    const task = published.find(e => e.type === 'agent.task') as AgentTaskEvent;
    expect(task.payload.metadata).toMatchObject({
      delegationOrigin: {
        conversationId: 'user-conv',
        channelId: 'email',
        agentId: 'coordinator',
        originalTask: 'find the acquisition comps',
      },
      originator: { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C "$WT" exec vitest run skills/delegate/handler.test.ts`
Expected: FAIL — `metadata` has only `originator`, no `delegationOrigin`.

- [ ] **Step 3: Implement the forwarding**

In `skills/delegate/handler.ts`, replace the `metadata:` property of the `createAgentTask({ … })` call (currently the `ctx.taskMetadata?.originator ? { originator: … } : undefined` ternary) with a built object. Insert this just before the `const taskEvent = createAgentTask({` line:

```ts
    // Forward the coordinator's relay context so that if the specialist mints a secret-capture
    // link, the capture origin can re-enter the COORDINATOR (a deliverable channel) and re-delegate
    // back to this specialist via resume_token (#995). originalTask is the specialist's brief, used
    // to build that resume_token. Only `delegate` sets delegationOrigin — it is the structural
    // signal that a task is running as a delegated specialist.
    const delegationMetadata: Record<string, unknown> = {
      delegationOrigin: {
        conversationId: ctx.conversationId,
        channelId: ctx.channelId,
        agentId: ctx.agentId,
        originalTask: effectiveTask,
      },
    };
    // Preserve the originator forwarding (#972) — without it the specialist loses the chain's
    // TaskOriginator and isPrincipalOriginated() goes false for every skill in its turn.
    if (ctx.taskMetadata?.originator) {
      delegationMetadata.originator = ctx.taskMetadata.originator;
    }
```

Then set the `createAgentTask` call's metadata to:

```ts
      metadata: delegationMetadata,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C "$WT" exec vitest run skills/delegate/handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Bump skill version + typecheck**

In `skills/delegate/skill.json`, bump the `version` patch (e.g. `0.x.Y` → `0.x.(Y+1)`).
Run: `pnpm -C "$WT" run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add skills/delegate/handler.ts skills/delegate/handler.test.ts skills/delegate/skill.json
git -C "$WT" commit -m "feat: delegate forwards coordinator relay context for specialist resume (#995)"
```

---

### Task 5: `secret-capture-request` builds resume_token + retargets origin when delegated

**Files:**
- Create: `src/secrets/build-capture-origin.ts` (shared helper, also used by Task 6)
- Create: `src/secrets/build-capture-origin.test.ts`
- Modify: `skills/secret-capture-request/handler.ts`
- Modify: `skills/secret-capture-request/skill.json` (version bump)
- Modify: `skills/secret-capture-request/handler.test.ts`

**Interfaces:**
- Consumes: `ctx.taskMetadata.delegationOrigin` (Task 4), `encodeResumeToken` (Task 1), `CaptureOrigin.resumeToken` (Task 2).
- Produces: `buildCaptureOrigin(ctx: SkillContext, resumeIntent: string): CaptureOrigin` in `src/secrets/build-capture-origin.ts` — shared with Task 6. Returns the agent's own routing when coordinator-minted; retargets at the coordinator with a `resumeToken` when delegated. The delegation-detection + retarget + token-mint logic lives ONLY here (no duplication across the two capture skills).

- [ ] **Step 1: Write the failing tests**

First, the shared helper's own unit test. Create `src/secrets/build-capture-origin.test.ts`:

```ts
// build-capture-origin.test.ts — shared capture-origin builder for the secret-capture skills (#995).
import { describe, it, expect } from 'vitest';
import { buildCaptureOrigin } from './build-capture-origin.js';
import { decodeResumeToken } from '../agents/resume-token.js';
import type { SkillContext } from '../skills/types.js';

function ctx(over: Partial<SkillContext> = {}): SkillContext {
  return {
    conversationId: 'own-conv',
    channelId: 'internal',
    agentId: 'accounts-specialist',
    taskEventId: 'evt-1',
    ...over,
  } as unknown as SkillContext;
}

describe('buildCaptureOrigin (#995)', () => {
  it("returns the agent's own routing and no resume_token when not delegated", () => {
    const origin = buildCaptureOrigin(
      ctx({ conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator' }),
      'check the balance',
    );
    expect(origin.conversationId).toBe('user-conv');
    expect(origin.channelId).toBe('email');
    expect(origin.agentId).toBe('coordinator');
    expect(origin.taskEventId).toBe('evt-1');
    expect(origin.resumeIntent).toBe('check the balance');
    expect(origin).not.toHaveProperty('resumeToken');
  });

  it('retargets at the coordinator and mints a resume_token when delegated', () => {
    const originator = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' };
    const origin = buildCaptureOrigin(
      ctx({
        conversationId: 'delegate-xyz',
        channelId: 'internal',
        agentId: 'accounts-specialist',
        taskMetadata: {
          originator,
          delegationOrigin: { conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator', originalTask: 'log into Aeroplan and check balance' },
        },
      }),
      'check the balance',
    );
    expect(origin.conversationId).toBe('user-conv');
    expect(origin.channelId).toBe('email');
    expect(origin.agentId).toBe('coordinator');
    expect(origin.originator).toEqual(originator);
    // The coordinator's task id isn't threaded; subscriber falls back to the event id.
    expect(origin.taskEventId).toBeUndefined();
    const decoded = decodeResumeToken(origin.resumeToken!)!;
    expect(decoded.agent).toBe('accounts-specialist');
    expect(decoded.original_task).toBe('log into Aeroplan and check balance');
    expect(decoded.context).toBe('check the balance');
  });

  it('falls back to own routing when delegationOrigin is incomplete (missing channelId)', () => {
    const origin = buildCaptureOrigin(
      ctx({
        conversationId: 'delegate-xyz',
        channelId: 'internal',
        agentId: 'accounts-specialist',
        taskMetadata: { delegationOrigin: { conversationId: 'user-conv', agentId: 'coordinator', originalTask: 'x' } },
      }),
      'intent',
    );
    expect(origin.channelId).toBe('internal');
    expect(origin).not.toHaveProperty('resumeToken');
  });
});
```

Then the handler-level tests. In `skills/secret-capture-request/handler.test.ts`, add:

```ts
  it('retargets origin at the coordinator and mints a resume_token when delegated (#995)', async () => {
    const minter = fakeMinter();
    const originator = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' };
    const ctx = makeCtx(
      { secret_name: 'Aeroplan password', resume_intent: 'check the Aeroplan balance' },
      {
        secretCapture: minter,
        // Specialist's own (internal) routing — must NOT be used as the resume target:
        conversationId: 'delegate-xyz',
        channelId: 'internal',
        agentId: 'accounts-specialist',
        taskMetadata: {
          originator,
          delegationOrigin: { conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator', originalTask: 'log into Aeroplan and check balance' },
        },
      },
    );
    await new SecretCaptureRequestHandler().execute(ctx);
    const call = (minter.userCalls[0] as { origin: Record<string, unknown> });
    // Re-entry targets the coordinator on its deliverable channel, not the internal specialist ctx.
    expect(call.origin.conversationId).toBe('user-conv');
    expect(call.origin.channelId).toBe('email');
    expect(call.origin.agentId).toBe('coordinator');
    expect(call.origin.originator).toEqual(originator);
    // The resume_token names the specialist to re-delegate to.
    const { decodeResumeToken } = await import('../../src/agents/resume-token.js');
    const decoded = decodeResumeToken(call.origin.resumeToken as string)!;
    expect(decoded.agent).toBe('accounts-specialist');
    expect(decoded.original_task).toBe('log into Aeroplan and check balance');
  });

  it('does NOT set resumeToken or retarget when not delegated (coordinator-minted)', async () => {
    const minter = fakeMinter();
    const ctx = makeCtx(
      { secret_name: 'Aeroplan password' },
      { secretCapture: minter, conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator' },
    );
    await new SecretCaptureRequestHandler().execute(ctx);
    const call = (minter.userCalls[0] as { origin: Record<string, unknown> });
    expect(call.origin.agentId).toBe('coordinator');
    expect(call.origin).not.toHaveProperty('resumeToken');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "$WT" exec vitest run src/secrets/build-capture-origin.test.ts skills/secret-capture-request/handler.test.ts`
Expected: the new tests FAIL (helper module `./build-capture-origin.js` missing; handler still uses the inline non-delegated origin).

- [ ] **Step 3: Create the shared helper**

Create `src/secrets/build-capture-origin.ts`:

```ts
// build-capture-origin.ts — shared origin builder for the secret-capture skills (#995).
//
// Both secret-capture-request (user secrets) and system-secret-capture-request (channel/system
// credentials) need the same logic: capture the agent's routing so redeem can re-enter it, and —
// when the agent runs as a DELEGATED specialist — retarget the resume at the coordinator (a
// deliverable channel) and mint a resume_token so the coordinator can re-delegate back to the
// specialist. This helper holds NO secret material: only routing, names, and an NL intent.

import { encodeResumeToken } from '../agents/resume-token.js';
import type { CaptureOrigin } from './secret-capture-service.js';
import type { SkillContext } from '../skills/types.js';

/** Shape the delegate skill writes into task metadata (#995). All fields optional because it is
 *  decoded from opaque metadata; the retarget only fires when the routing trio is fully present. */
interface DelegationOrigin {
  conversationId?: string;
  channelId?: string;
  agentId?: string;
  originalTask?: string;
}

/**
 * Build the CaptureOrigin to persist on a capture token.
 *
 * - Non-delegated (coordinator-minted): returns the agent's own routing so redeem re-enters it
 *   directly (#972).
 * - Delegated specialist: retargets routing at the coordinator and attaches a resume_token naming
 *   this specialist + its brief, so the redeem event re-enters the coordinator to re-delegate (#995).
 *
 * @param resumeIntent natural-language description of what to resume (the user ask, or the label).
 */
export function buildCaptureOrigin(ctx: SkillContext, resumeIntent: string): CaptureOrigin {
  const originator = ctx.taskMetadata?.originator as Record<string, unknown> | undefined;
  const delegationOrigin = ctx.taskMetadata?.delegationOrigin as DelegationOrigin | undefined;

  // Delegated specialist — only when delegate populated the full routing trio. Re-entering the
  // specialist's own 'internal' channel would reach no user, so retarget at the coordinator.
  if (
    delegationOrigin &&
    ctx.agentId &&
    delegationOrigin.conversationId &&
    delegationOrigin.channelId &&
    delegationOrigin.agentId
  ) {
    return {
      conversationId: delegationOrigin.conversationId,
      channelId: delegationOrigin.channelId,
      agentId: delegationOrigin.agentId,
      // taskEventId omitted: the coordinator's task id isn't threaded here; the resume subscriber
      // falls back to the event id for parentEventId.
      originator,
      resumeIntent,
      resumeToken: encodeResumeToken({
        agent: ctx.agentId,
        originalTask: delegationOrigin.originalTask ?? resumeIntent,
        context: resumeIntent,
      }),
    };
  }

  // Non-delegated — re-enter this agent in this conversation directly (#972).
  return {
    conversationId: ctx.conversationId,
    channelId: ctx.channelId,
    agentId: ctx.agentId,
    taskEventId: ctx.taskEventId,
    originator,
    resumeIntent,
  };
}
```

Run: `pnpm -C "$WT" exec vitest run src/secrets/build-capture-origin.test.ts`
Expected: PASS (3 helper tests).

- [ ] **Step 3b: Use the helper in the handler**

In `skills/secret-capture-request/handler.ts`, add the import:

```ts
import { buildCaptureOrigin } from '../../src/secrets/build-capture-origin.js';
```

Remove the now-unused `const originator = ctx.taskMetadata?.originator as …` line (the helper reads the originator from `ctx.taskMetadata`). Keep the `resumeIntent` computation. Just before the `try {` that calls `mintUserSecret`, add:

```ts
    // Build the capture origin via the shared helper (#995): re-enter this agent directly when
    // coordinator-minted, or retarget at the coordinator with a resume_token when this skill runs
    // as a delegated specialist. Holds no secret value.
    const origin = buildCaptureOrigin(ctx, resumeIntent);
```

Then change the `mintUserSecret` call to pass the variable:

```ts
      const { rawToken, secretName, expiresAt } = await ctx.secretCapture.mintUserSecret({
        rawName: secret_name,
        label: labelStr,
        valueFormat,
        origin,
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C "$WT" exec vitest run src/secrets/build-capture-origin.test.ts skills/secret-capture-request/handler.test.ts`
Expected: PASS (all tests, incl. the existing `captures origin routing context` test which still sees the non-delegated path).

- [ ] **Step 5: Bump version + typecheck**

Bump `version` patch in `skills/secret-capture-request/skill.json`.
Run: `pnpm -C "$WT" run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add src/secrets/build-capture-origin.ts src/secrets/build-capture-origin.test.ts skills/secret-capture-request/handler.ts skills/secret-capture-request/handler.test.ts skills/secret-capture-request/skill.json
git -C "$WT" commit -m "feat: secret-capture-request mints resume_token + retargets origin when delegated (#995)"
```

---

### Task 6: `system-secret-capture-request` adds origin threading + resume_token

The system variant passes **no origin today**, so setup-wizard captures dead-end. Add origin threading mirroring Task 5 (it always runs as the setup-wizard specialist). It has no `resume_intent` input — derive the intent from the label.

**Files:**
- Modify: `skills/system-secret-capture-request/handler.ts`
- Modify: `skills/system-secret-capture-request/skill.json` (version bump)
- Modify: `skills/system-secret-capture-request/handler.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

If `skills/system-secret-capture-request/handler.test.ts` does not exist, create it; otherwise append the test. (Header mirrors `secret-capture-request/handler.test.ts`, using `SystemSecretCaptureRequestHandler` and asserting `systemCalls`.)

```ts
// handler.test.ts — system-secret-capture-request skill (#995 origin threading).
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { SystemSecretCaptureRequestHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { SecretCaptureMinter, MintResult } from '../../src/secrets/secret-capture-service.js';
import { decodeResumeToken } from '../../src/agents/resume-token.js';

function fakeMinter(over: Partial<MintResult> = {}): SecretCaptureMinter & { userCalls: unknown[]; systemCalls: unknown[] } {
  const userCalls: unknown[] = [];
  const systemCalls: unknown[] = [];
  return {
    userCalls, systemCalls,
    async mintUserSecret(args) { userCalls.push(args); return { rawToken: 'abc123', secretName: 'user.x', expiresAt: new Date(), ...over }; },
    async mintSystemSecret(args) { systemCalls.push(args); return { rawToken: 'abc123', secretName: 'channel.email.nylas_api_key', expiresAt: new Date(), ...over }; },
  };
}

function makeCtx(input: Record<string, unknown>, overrides: Partial<SkillContext> = {}): SkillContext {
  return { input, log: pino({ level: 'silent' }), secretCapture: fakeMinter(), appOrigin: 'https://curia.example.com', ...overrides } as unknown as SkillContext;
}

describe('SystemSecretCaptureRequestHandler (#995)', () => {
  it('threads coordinator routing + resume_token when delegated (setup-wizard)', async () => {
    const minter = fakeMinter();
    const originator = { contactId: 'ceo', systemRole: 'principal', channel: 'web', initiatedAt: 't' };
    const ctx = makeCtx(
      { secret_name: 'channel.email.nylas_api_key', label: 'Nylas API key' },
      {
        secretCapture: minter,
        conversationId: 'delegate-xyz', channelId: 'internal', agentId: 'setup-wizard',
        taskMetadata: { originator, delegationOrigin: { conversationId: 'user-conv', channelId: 'web', agentId: 'coordinator', originalTask: 'set up email' } },
      },
    );
    const result = await new SystemSecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(true);
    const call = (minter.systemCalls[0] as { origin: Record<string, unknown> });
    expect(call.origin.conversationId).toBe('user-conv');
    expect(call.origin.channelId).toBe('web');
    expect(call.origin.agentId).toBe('coordinator');
    expect(call.origin.originator).toEqual(originator);
    expect(decodeResumeToken(call.origin.resumeToken as string)!.agent).toBe('setup-wizard');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C "$WT" exec vitest run skills/system-secret-capture-request/handler.test.ts`
Expected: FAIL — `mintSystemSecret` is called with no `origin`.

- [ ] **Step 3: Implement**

In `skills/system-secret-capture-request/handler.ts`, add the import:

```ts
import { buildCaptureOrigin } from '../../src/secrets/build-capture-origin.js';
```

After computing `labelStr` and `valueFormat`, before the `try {` that calls `mintSystemSecret`, add:

```ts
    // Origin threading (#995) via the shared helper. The system variant has no resume_intent input,
    // so derive the intent from the label. The setup-wizard always runs as a delegated specialist,
    // so the helper retargets the resume at the coordinator and mints a resume_token to re-delegate
    // back to the wizard. (When somehow run non-delegated, it falls back to the agent's own routing.)
    const origin = buildCaptureOrigin(ctx, labelStr);
```

Change the `mintSystemSecret({ … })` call to pass `origin`:

```ts
      const { rawToken, secretName, expiresAt } = await ctx.secretCapture.mintSystemSecret({
        rawName: secret_name,
        label: labelStr,
        valueFormat,
        origin,
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C "$WT" exec vitest run skills/system-secret-capture-request/handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Bump version + typecheck**

Bump `version` patch in `skills/system-secret-capture-request/skill.json`.
Run: `pnpm -C "$WT" run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add skills/system-secret-capture-request/handler.ts skills/system-secret-capture-request/handler.test.ts skills/system-secret-capture-request/skill.json
git -C "$WT" commit -m "feat: system-secret-capture-request threads origin + resume_token (#995)"
```

---

### Task 7: Resume subscriber re-delegates through the coordinator

**Files:**
- Modify: `src/secrets/secret-capture-resume-subscriber.ts`
- Modify: `src/secrets/secret-capture-resume-subscriber.test.ts`

**Interfaces:**
- Consumes: `SecretCapturedPayload.resumeToken` (Task 3), `decodeResumeToken` (Task 1).

- [ ] **Step 1: Write the failing tests**

In `src/secrets/secret-capture-resume-subscriber.test.ts`, add the import at top:

```ts
import { encodeResumeToken } from '../agents/resume-token.js';
```

Add these tests inside the `describe('SecretCaptureResumeSubscriber')` block:

```ts
  it('re-enters the coordinator with a re-delegate instruction when a resume_token is present (#995)', async () => {
    const { published, emit, routingCalls } = makeSubscriber();
    const resumeToken = encodeResumeToken({ agent: 'accounts-specialist', originalTask: 'log into Aeroplan', context: 'need password' });
    // Origin points at the COORDINATOR (deliverable), as the capture skill retargeted it.
    await emit(makeCapturedEvent({
      label: 'Aeroplan password',
      conversationId: 'user-conv',
      channelId: 'email',
      agentId: 'coordinator',
      resumeIntent: 'check the Aeroplan balance',
      resumeToken,
    }));

    expect(published).toHaveLength(1);
    const task = published[0]!.event as AgentTaskEvent;
    expect(task.payload.agentId).toBe('coordinator');
    expect(task.payload.conversationId).toBe('user-conv');
    expect(task.payload.channelId).toBe('email');
    // Content names the specialist to re-delegate to and embeds the token verbatim.
    expect(task.payload.content).toContain('accounts-specialist');
    expect(task.payload.content).toContain(resumeToken);
    // originator preserved; routing seeded for delivery.
    expect(task.payload.metadata).toEqual({ originator: ORIGINATOR });
    expect(routingCalls).toHaveLength(1);
  });

  it('skips with a log when the resume_token cannot be decoded (#995)', async () => {
    const { published, emit } = makeSubscriber();
    await emit(makeCapturedEvent({ conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator', resumeToken: '!!!garbage!!!' }));
    expect(published).toHaveLength(0);
  });

  it('never leaks the secret value on the re-delegation path (#995)', async () => {
    const { published, emit } = makeSubscriber();
    const resumeToken = encodeResumeToken({ agent: 'accounts-specialist', originalTask: 'log into Aeroplan', context: 'need password' });
    await emit(makeCapturedEvent({ conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator', resumeToken }));
    expect(JSON.stringify(published[0]!.event)).not.toContain('hunter2');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "$WT" exec vitest run src/secrets/secret-capture-resume-subscriber.test.ts`
Expected: the new tests FAIL (content has no `accounts-specialist` / token; decode-skip not implemented).

- [ ] **Step 3: Implement**

In `src/secrets/secret-capture-resume-subscriber.ts`:

Add the import:

```ts
import { decodeResumeToken } from '../agents/resume-token.js';
```

Add `resumeToken` to the payload destructure (the `const { secretName, … } = event.payload;` line):

```ts
    const { secretName, label, conversationId, agentId, channelId, taskEventId, resumeIntent, resumeToken, originator } = event.payload;
```

Update the `NON_DELIVERABLE_CHANNELS` comment block (lines ~41–52 and ~100–105) to note specialist resume is now handled: replace the phrase "Cleanly resuming a delegated specialist is a separate feature … Tracked as follow-up." with:

```ts
 * A delegated specialist now resumes by minting its capture link with the COORDINATOR's routing
 * + a resume_token (#995), so by the time the event reaches here channelId is already the
 * coordinator's deliverable channel and this guard passes. This guard now only catches a
 * genuinely unroutable mint (an internal-channel link with no delegation context), which should
 * not occur but must not dead-end loudly into a non-deliverable channel.
```

Replace the content construction (the `const displayName = …; const intentLine = …; const content = …;` block) with:

```ts
    const displayName = label ?? secretName;
    let content: string;
    if (resumeToken) {
      // Delegated-specialist resume (#995): decode the token to recover the specialist name, then
      // instruct the coordinator to re-delegate with the token (verbatim) and relay the reply.
      const decoded = decodeResumeToken(resumeToken);
      if (!decoded) {
        // A system-minted token should always decode; a malformed one is unrecoverable, so skip
        // (don't fabricate a re-delegation) and log loudly rather than swallow.
        this.logger.warn(
          { eventId: event.id, secretName, agentId },
          'secret.captured carried a resume_token that could not be decoded — skipping specialist re-delegation',
        );
        return;
      }
      const goalLine = resumeIntent ? ` (Original goal: ${resumeIntent}.)` : '';
      content =
        `The secret '${displayName}' that a specialist asked for was just captured and saved to the vault. ` +
        `The specialist '${decoded.agent}' paused waiting for it. Re-delegate to '${decoded.agent}' to continue, ` +
        `passing this resume_token EXACTLY as given (do not alter, redact, or shorten it):\n\n${resumeToken}\n\n` +
        `Then relay its reply to the user.${goalLine} If '${decoded.agent}' reports it is still missing other ` +
        `secrets it already requested, relay that to the user — do not send new capture links for secrets ` +
        `whose links are still pending.`;
    } else {
      const intentLine = resumeIntent ? ` Original request: ${resumeIntent}.` : '';
      content =
        `The secret '${displayName}' was just captured and saved to the vault.${intentLine} ` +
        `If you now have everything you need to continue, proceed. Otherwise, tell the user what ` +
        `is still outstanding (check your conversation history for any other secrets you asked for).`;
    }
```

(The `markDispatched(event.id)` call stays where it is — before this content block. A decode-fail `return` after marking is fine: an undecodable token is permanently bad, so not retrying is correct.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C "$WT" exec vitest run src/secrets/secret-capture-resume-subscriber.test.ts`
Expected: PASS — incl. the existing `skips … non-user-facing channel` test (an internal mint with no resumeToken still skips) and the existing coordinator-self-resume tests (no resumeToken → unchanged content).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -C "$WT" run typecheck`
Expected: no errors.

```bash
git -C "$WT" add src/secrets/secret-capture-resume-subscriber.ts src/secrets/secret-capture-resume-subscriber.test.ts
git -C "$WT" commit -m "feat: resume subscriber re-delegates specialist captures via coordinator (#995)"
```

---

### Task 8: Setup-wizard restart messaging

System bootstrap credentials are read once at startup, so a captured channel credential is not live until a restart. The resume subscriber stays dumb; the wizard tells the user. Add one prompt line and bump the agent version.

**Files:**
- Modify: `agents/setup-wizard.yaml`

- [ ] **Step 1: Add the prompt guidance**

In `agents/setup-wizard.yaml`, in the secret-capture guidance section (near the existing "One link per secret … expire in 30 minutes." line), add a bullet:

```yaml
    - After the principal fills a credential link, you may be resumed automatically to continue.
      A channel credential or API key (e.g. nylas_api_key, signal_phone_number) does NOT take
      effect until Curia restarts — so once it is captured, confirm it is saved and tell the
      principal it will be live after the next restart. Do not claim the channel is working yet.
      A dynamically-used user secret needs no restart; use it right away.
```

- [ ] **Step 2: Bump the agent version**

In `agents/setup-wizard.yaml`, bump the `version` patch (e.g. `0.1.0` → `0.1.1`).

- [ ] **Step 3: Typecheck (catches YAML loaded by config) + commit**

Run: `pnpm -C "$WT" run typecheck`
Expected: no errors.

```bash
git -C "$WT" add agents/setup-wizard.yaml
git -C "$WT" commit -m "feat: setup-wizard tells user a restart is needed for captured credentials (#995)"
```

---

### Task 9: Flow integration test + CHANGELOG

A single test that chains the produce side (capture skill → service → event) to the consume side (resume subscriber), proving the resume_token + coordinator routing + originator survive end-to-end with no secret value — without a DB or an LLM.

**Files:**
- Create: `src/secrets/specialist-resume-flow.test.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the integration test**

Create `src/secrets/specialist-resume-flow.test.ts`:

```ts
// specialist-resume-flow.test.ts — end-to-end (no DB/LLM) flow for #995: a delegated specialist
// mints a capture link → redeem → secret.captured → coordinator is re-entered to re-delegate.
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { SecretCaptureRequestHandler } from '../../skills/secret-capture-request/handler.js';
import { SecretCaptureResumeSubscriber, type ResumeRoutingRegistrar } from './secret-capture-resume-subscriber.js';
import { createSecretCaptured } from '../bus/events.js';
import type { SkillContext } from '../skills/types.js';
import type { SecretCaptureMinter, CaptureOrigin } from './secret-capture-service.js';
import type { EventBus } from '../bus/bus.js';
import type { BusEvent, Layer, EventType, AgentTaskEvent } from '../bus/events.js';

describe('specialist secret-capture resume flow (#995)', () => {
  it('delegated mint → secret.captured → coordinator re-delegate task (value never leaks)', async () => {
    // 1. Capture skill, run as a delegated specialist, records the origin it would persist.
    let captured: CaptureOrigin | undefined;
    const minter: SecretCaptureMinter = {
      async mintUserSecret(args) { captured = args.origin; return { rawToken: 'tok', secretName: 'user.aeroplan_password', expiresAt: new Date(Date.now() + 1e6) }; },
      async mintSystemSecret(args) { captured = args.origin; return { rawToken: 'tok', secretName: 'x', expiresAt: new Date() }; },
    };
    const originator = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' };
    const skillCtx = {
      input: { secret_name: 'Aeroplan password', resume_intent: 'check the Aeroplan balance' },
      log: pino({ level: 'silent' }),
      secretCapture: minter,
      appOrigin: 'https://curia.example.com',
      conversationId: 'delegate-xyz', channelId: 'internal', agentId: 'accounts-specialist',
      taskMetadata: { originator, delegationOrigin: { conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator', originalTask: 'log into Aeroplan and check balance' } },
    } as unknown as SkillContext;
    const res = await new SecretCaptureRequestHandler().execute(skillCtx);
    expect(res.success).toBe(true);
    expect(captured!.agentId).toBe('coordinator');
    expect(captured!.resumeToken).toBeTruthy();

    // 2. Redeem returns CapturedContext mirroring the persisted origin (the service round-trips it,
    //    covered in Task 2); the endpoint publishes secret.captured from it.
    const event = createSecretCaptured({
      secretName: 'user.aeroplan_password',
      label: 'Aeroplan password',
      conversationId: captured!.conversationId,
      channelId: captured!.channelId,
      agentId: captured!.agentId,
      resumeIntent: captured!.resumeIntent,
      originator: captured!.originator,
      resumeToken: captured!.resumeToken,
    });

    // 3. Real subscriber re-enters the coordinator.
    const published: Array<{ layer: Layer; event: BusEvent }> = [];
    const handlers = new Map<EventType, Array<(e: BusEvent) => unknown>>();
    const bus = {
      subscribe(type: EventType, _l: Layer, h: (e: BusEvent) => unknown) { const a = handlers.get(type) ?? []; a.push(h); handlers.set(type, a); },
      async publish(layer: Layer, event: BusEvent) { published.push({ layer, event }); },
    } as unknown as EventBus;
    const routingCalls: Array<unknown> = [];
    const register: ResumeRoutingRegistrar = (_id, routing) => { routingCalls.push(routing); };
    new SecretCaptureResumeSubscriber(bus, pino({ level: 'silent' }), register).start();
    for (const h of handlers.get('secret.captured') ?? []) await h(event);

    expect(published).toHaveLength(1);
    const task = published[0]!.event as AgentTaskEvent;
    expect(task.payload.agentId).toBe('coordinator');         // re-enters the coordinator…
    expect(task.payload.conversationId).toBe('user-conv');    // …in the user's conversation…
    expect(task.payload.channelId).toBe('email');             // …on a deliverable channel.
    expect(task.payload.content).toContain('accounts-specialist');  // re-delegate target
    expect(task.payload.content).toContain(captured!.resumeToken);  // token forwarded verbatim
    expect(task.payload.metadata).toEqual({ originator });    // originator preserved end-to-end
    expect(routingCalls).toHaveLength(1);
    // Privacy: no secret value anywhere in the chain.
    expect(JSON.stringify({ captured, event, task })).not.toContain('hunter2');
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm -C "$WT" exec vitest run src/secrets/specialist-resume-flow.test.ts`
Expected: PASS.

- [ ] **Step 3: Update CHANGELOG**

In `CHANGELOG.md`, under `## [Unreleased]`, add to **Added** (create the section if missing):

```markdown
- **Specialist secret-capture resume** — a delegated specialist (or the setup-wizard) that mints a secret-capture link is now resumed on redeem: re-entry routes through the coordinator, which re-delegates to the specialist via the `delegate` resume_token. Preserves the no-value and originator invariants. (#995)
```

And under **Changed**:

```markdown
- **`SecretCapturedPayload`** — gained an optional `resumeToken` field (public bus event surface). (#995)
```

- [ ] **Step 4: Commit**

```bash
git -C "$WT" add src/secrets/specialist-resume-flow.test.ts CHANGELOG.md
git -C "$WT" commit -m "test: end-to-end specialist secret-capture resume flow + changelog (#995)"
```

---

### Task 10: Full verification

- [ ] **Step 1: Typecheck the whole project**

Run: `pnpm -C "$WT" run typecheck`
Expected: no errors.

- [ ] **Step 2: Run the full unit suite (or at least all touched files)**

Run: `pnpm -C "$WT" exec vitest run src/agents/resume-token.test.ts src/secrets/build-capture-origin.test.ts src/secrets/secret-capture-service.test.ts src/secrets/secret-capture-resume-subscriber.test.ts src/secrets/specialist-resume-flow.test.ts skills/delegate/handler.test.ts skills/secret-capture-request/handler.test.ts skills/system-secret-capture-request/handler.test.ts`
Expected: all PASS.

- [ ] **Step 3: Lint (if configured)**

Run: `pnpm -C "$WT" run lint`
Expected: no errors (or matches baseline).

- [ ] **Step 4: Migration ordering check**

Run: `ls "$WT"/src/db/migrations/ | sort | tail -5`
Expected: `061_add_secret_capture_resume_token.sql` present; no duplicate `061_*`.

- [ ] **Step 5: Pre-PR review (per global workflow)**

Run the `pr-review-toolkit:code-reviewer`, `pr-review-toolkit:silent-failure-hunter`, and (since this touches secrets/credentials) a security review subagent in parallel against the branch diff vs `main`. Address high-priority findings before opening the PR.

- [ ] **Step 6: Open the PR**

Body must include `Closes #995`. CI must start (`gh run list --branch feat/specialist-secret-resume-995 --limit 1`).

---

## Self-Review notes

- **Spec §1 (thread relay context)** → Task 4. **§2 (build token + retarget)** → Tasks 5, 6 (+ helper Task 1). **§3 (persist + propagate)** → Tasks 2, 3. **§4 (re-enter coordinator)** → Task 7. **§5 (wizard messaging)** → Task 8. **§6 (multi-secret/partial)** → covered by the per-event resume behavior + the re-delegate content's "don't re-send pending links" instruction (Task 7) + the wizard reasoning.
- **AC coverage:** resume reaches user via coordinator (Tasks 7, 9); reuses resume_token (Tasks 1, 5–7); no-value invariant (Tasks 2, 7, 9 assertions); originator preserved (Tasks 4, 7, 9); #984 guard updated/retained (Task 7); tests (every task); wizard stance documented (Task 8 + spec).
- **Type consistency:** `resumeToken` (camel) on TS interfaces; `resume_token` (snake) in SQL + the resume_token JSON field; `delegationOrigin` shape `{ conversationId, channelId, agentId, originalTask }` identical in Tasks 4/5/6/9.
