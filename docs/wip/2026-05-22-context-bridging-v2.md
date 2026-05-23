# Context Bridging v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the working-memory-based context bridging system with a delegation-aware outbound context registry backed by a dedicated Postgres table, enabling specialist agents to route proactive messages through the coordinator and receive delegated replies.

**Architecture:** A new `OutboundContextService` owns all CRUD on a dedicated `outbound_context` table. Send skills (`signal-send`, `email-send`, `email-reply`) gain an optional `context_bridge` input parameter and write entries via a narrow scoped capability. The dispatcher reads active entries from the service instead of working memory. A new `context-bridge-release` skill lets the coordinator mark entries as released.

**Tech Stack:** TypeScript (ESM), PostgreSQL 16, Vitest, pino logging

**Design spec:** `docs/wip/2026-05-16-context-bridging-v2-design.md`

**Issue:** #615

---

## Task 1: Create the `outbound_context` migration

**Files:**
- Create: `src/db/migrations/042_create_outbound_context.sql`

- [ ] **Step 1: Verify migration number is available**

Run: `ls src/db/migrations/ | sort | tail -3`

Expected output should show `041_add_bullpen_threads_originator.sql` as the latest. If `042` is already taken (another branch landed), use the next available number.

- [ ] **Step 2: Write the migration**

```sql
-- Up Migration

CREATE TABLE outbound_context (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  content_preview  TEXT NOT NULL,
  expected_reply   TEXT,
  delegation_hint  TEXT,
  metadata         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  released         BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_outbound_context_active
  ON outbound_context (expires_at) WHERE released = false;

-- Rollback: DROP TABLE outbound_context;
```

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/042_create_outbound_context.sql
git commit -m "feat: add outbound_context table migration (#615)"
```

---

## Task 2: Create OutboundContextService types and implementation

**Files:**
- Create: `src/dispatch/outbound-context.ts`
- Create: `src/dispatch/outbound-context.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/dispatch/outbound-context.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundContextService, ScopedOutboundContext } from './outbound-context.js';
import type { DbPool } from '../db/connection.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makePool() {
  return { query: vi.fn() } as unknown as DbPool;
}

describe('OutboundContextService', () => {
  let pool: ReturnType<typeof makePool>;
  let service: OutboundContextService;

  beforeEach(() => {
    pool = makePool();
    service = new OutboundContextService(pool, logger);
  });

  describe('register', () => {
    it('inserts a row and returns the generated ID', async () => {
      const fakeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: fakeId }],
      });

      const id = await service.register({
        conversationId: 'conv-1',
        channelId: 'signal',
        agentId: 'meeting-debrief',
        content: 'Hello, any takeaways from the meeting?',
        expectedReply: 'Meeting notes',
        delegationHint: 'Delegate to meeting-debrief',
        metadata: { meeting: 'sync' },
        expiresInHours: 48,
      });

      expect(id).toBe(fakeId);
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toContain('INSERT INTO outbound_context');
      // Verify parameterized query — 8 params ($1..$8)
      expect(call[1]).toHaveLength(8);
      expect(call[1][0]).toBe('conv-1');       // conversation_id
      expect(call[1][1]).toBe('signal');        // channel_id
      expect(call[1][2]).toBe('meeting-debrief'); // agent_id
    });

    it('truncates content_preview to 300 characters', async () => {
      const longContent = 'x'.repeat(500);
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: 'some-id' }],
      });

      await service.register({
        conversationId: 'conv-1',
        channelId: 'email',
        agentId: 'coordinator',
        content: longContent,
      });

      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      const preview = call[1][3] as string; // content_preview param
      expect(preview.length).toBeLessThanOrEqual(301); // 300 + ellipsis
      expect(preview.endsWith('…')).toBe(true);
    });

    it('defaults expiresInHours to 24 when not provided', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: 'some-id' }],
      });

      await service.register({
        conversationId: 'conv-1',
        channelId: 'signal',
        agentId: 'coordinator',
        content: 'Short message',
      });

      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      // expires_at param — should be ~24h from now
      const expiresAt = call[1][7] as Date;
      const expectedMs = Date.now() + 24 * 60 * 60 * 1000;
      expect(Math.abs(expiresAt.getTime() - expectedMs)).toBeLessThan(5000);
    });
  });

  describe('getActive', () => {
    it('returns non-released, non-expired entries ordered by created_at DESC', async () => {
      const rows = [
        {
          id: 'id-1', conversation_id: 'conv-1', channel_id: 'signal',
          agent_id: 'meeting-debrief', content_preview: 'Hello',
          expected_reply: 'Notes', delegation_hint: 'Delegate to meeting-debrief',
          metadata: { key: 'value' }, created_at: new Date(), expires_at: new Date(),
          released: false,
        },
      ];
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows });

      const result = await service.getActive();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('id-1');
      expect(result[0].conversationId).toBe('conv-1');
      expect(result[0].agentId).toBe('meeting-debrief');
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toContain('released = false');
      expect(call[0]).toContain('expires_at > now()');
    });

    it('respects the limit parameter', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });

      await service.getActive(5);

      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1][0]).toBe(5);
    });

    it('defaults limit to 10', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });

      await service.getActive();

      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1][0]).toBe(10);
    });
  });

  describe('release', () => {
    it('sets released = true for the given entry ID', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: 1 });

      await service.release('entry-id-1');

      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toContain('UPDATE outbound_context');
      expect(call[0]).toContain('released = true');
      expect(call[1][0]).toBe('entry-id-1');
    });
  });

  describe('cleanupExpired', () => {
    it('deletes rows where released = true OR expires_at has passed', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: 3 });

      const count = await service.cleanupExpired();

      expect(count).toBe(3);
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toContain('DELETE FROM outbound_context');
    });
  });

  describe('formatInjectionBlock', () => {
    it('returns null when entries is empty', () => {
      const result = service.formatInjectionBlock([], 'original content');
      expect(result).toBeNull();
    });

    it('wraps entries with the ACTIVE OUTBOUND CONTEXT header and appends original content', () => {
      const entries = [{
        id: 'abc-123',
        conversationId: 'conv-1',
        channelId: 'signal',
        agentId: 'meeting-debrief',
        contentPreview: 'Any takeaways from the meeting?',
        expectedReply: 'Meeting notes',
        delegationHint: 'Delegate to meeting-debrief',
        metadata: { meeting: 'Strategy sync' },
        createdAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48h from now
        released: false,
      }];

      const result = service.formatInjectionBlock(entries, 'Hello from CEO');

      expect(result).not.toBeNull();
      expect(result).toContain('[ACTIVE OUTBOUND CONTEXT');
      expect(result).toContain('entry_id: abc-123');
      expect(result).toContain('via signal');
      expect(result).toContain('on behalf of meeting-debrief');
      expect(result).toContain('preview: "Any takeaways from the meeting?"');
      expect(result).toContain('expected reply: Meeting notes');
      expect(result).toContain('delegation: Delegate to meeting-debrief');
      expect(result).toContain('Hello from CEO');
    });

    it('omits optional fields when null', () => {
      const entries = [{
        id: 'abc-123',
        conversationId: 'conv-1',
        channelId: 'email',
        agentId: 'coordinator',
        contentPreview: 'Quick note',
        expectedReply: null,
        delegationHint: null,
        metadata: null,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        released: false,
      }];

      const result = service.formatInjectionBlock(entries, 'Reply');

      expect(result).not.toBeNull();
      expect(result).not.toContain('expected reply:');
      expect(result).not.toContain('delegation:');
      expect(result).not.toContain('context:');
    });
  });
});

describe('ScopedOutboundContext', () => {
  it('delegates register() to the service with conversationId pre-filled', async () => {
    const pool = makePool();
    const service = new OutboundContextService(pool, logger);
    const registerSpy = vi.spyOn(service, 'register').mockResolvedValue('new-id');

    const scoped = new ScopedOutboundContext(service, 'conv-42');
    const id = await scoped.register({
      channelId: 'signal',
      agentId: 'coordinator',
      content: 'Test message',
    });

    expect(id).toBe('new-id');
    expect(registerSpy).toHaveBeenCalledWith({
      conversationId: 'conv-42',
      channelId: 'signal',
      agentId: 'coordinator',
      content: 'Test message',
    });
  });

  it('delegates release() to the service', async () => {
    const pool = makePool();
    const service = new OutboundContextService(pool, logger);
    const releaseSpy = vi.spyOn(service, 'release').mockResolvedValue(undefined);

    const scoped = new ScopedOutboundContext(service, 'conv-42');
    await scoped.release('entry-1');

    expect(releaseSpy).toHaveBeenCalledWith('entry-1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix . vitest run src/dispatch/outbound-context.test.ts`

Expected: FAIL — module `./outbound-context.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// src/dispatch/outbound-context.ts
//
// Service class for the outbound context bridge registry. Owns all CRUD on the
// outbound_context table. The dispatcher uses the full service for inbound
// injection; send skills use a ScopedOutboundContext (narrow: register + release
// only) via the outboundContext capability.
//
// See docs/wip/2026-05-16-context-bridging-v2-design.md §2a.

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';

const MAX_PREVIEW_LENGTH = 300;
const DEFAULT_EXPIRY_HOURS = 24;

// ── Types ──────────────────────────────────────────────────────────────────

/** Input for registering a new outbound context entry. */
export interface OutboundContextEntry {
  conversationId: string;
  channelId: string;
  agentId: string;
  /** Full message content — truncated to MAX_PREVIEW_LENGTH for storage. */
  content: string;
  expectedReply?: string;
  delegationHint?: string;
  metadata?: Record<string, unknown>;
  /** Hours until automatic expiry. Default: 24. */
  expiresInHours?: number;
}

/** A row from the outbound_context table, with snake_case → camelCase mapping. */
export interface OutboundContextRow {
  id: string;
  conversationId: string;
  channelId: string;
  agentId: string;
  contentPreview: string;
  expectedReply: string | null;
  delegationHint: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  expiresAt: Date;
  released: boolean;
}

/** Narrow interface exposed to skills via the outboundContext capability. */
export interface OutboundContextCapability {
  register(entry: Omit<OutboundContextEntry, 'conversationId'>): Promise<string>;
  release(entryId: string): Promise<void>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function truncatePreview(content: string): string {
  if (content.length <= MAX_PREVIEW_LENGTH) return content;
  return content.slice(0, MAX_PREVIEW_LENGTH) + '…';
}

/** Format a relative time-ago string for the injection block. */
function timeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Format a relative time-until string for the injection block. */
function timeUntil(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'expired';
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return 'less than 1h';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function mapRow(row: Record<string, unknown>): OutboundContextRow {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    channelId: row.channel_id as string,
    agentId: row.agent_id as string,
    contentPreview: row.content_preview as string,
    expectedReply: (row.expected_reply as string) ?? null,
    delegationHint: (row.delegation_hint as string) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? null,
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
    released: row.released as boolean,
  };
}

// ── Service ────────────────────────────────────────────────────────────────

export class OutboundContextService {
  constructor(
    private pool: DbPool,
    private logger: Logger,
  ) {}

  /** Write a new outbound context entry. Returns the generated UUID. */
  async register(entry: OutboundContextEntry): Promise<string> {
    const preview = truncatePreview(entry.content);
    const expiresAt = new Date(
      Date.now() + (entry.expiresInHours ?? DEFAULT_EXPIRY_HOURS) * 3_600_000,
    );

    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO outbound_context
         (conversation_id, channel_id, agent_id, content_preview,
          expected_reply, delegation_hint, metadata, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        entry.conversationId,
        entry.channelId,
        entry.agentId,
        preview,
        entry.expectedReply ?? null,
        entry.delegationHint ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        expiresAt,
      ],
    );

    return result.rows[0].id;
  }

  /** Query all active (non-released, non-expired) entries. */
  async getActive(limit = 10): Promise<OutboundContextRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM outbound_context
       WHERE released = false AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map(mapRow);
  }

  /** Mark an entry as released — stop expecting replies. */
  async release(entryId: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbound_context SET released = true WHERE id = $1`,
      [entryId],
    );
  }

  /** Delete expired or released entries. Returns the count of rows deleted. */
  async cleanupExpired(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM outbound_context
       WHERE released = true OR expires_at <= now()`,
    );
    return result.rowCount ?? 0;
  }

  /**
   * Format the [ACTIVE OUTBOUND CONTEXT] injection block for the coordinator.
   * Returns null when there are no active entries (caller uses original content).
   */
  formatInjectionBlock(
    entries: OutboundContextRow[],
    originalContent: string,
  ): string | null {
    if (entries.length === 0) return null;

    const blocks = entries.map((e) => {
      const lines: string[] = [
        '---',
        `entry_id: ${e.id}`,
        `[sent ${timeAgo(e.createdAt)} via ${e.channelId}, on behalf of ${e.agentId}, expires in ${timeUntil(e.expiresAt)}]`,
        `preview: "${e.contentPreview}"`,
      ];
      if (e.expectedReply) lines.push(`expected reply: ${e.expectedReply}`);
      if (e.delegationHint) lines.push(`delegation: ${e.delegationHint}`);
      if (e.metadata) lines.push(`context: ${JSON.stringify(e.metadata)}`);
      lines.push('---');
      return lines.join('\n');
    });

    return [
      '[ACTIVE OUTBOUND CONTEXT — messages you\'ve sent that may receive replies]',
      ...blocks,
      '',
      originalContent,
    ].join('\n');
  }
}

// ── Scoped Wrapper ─────────────────────────────────────────────────────────

/**
 * Narrow capability surface injected into skills. Pre-scoped with
 * conversationId so skills don't need to know it.
 */
export class ScopedOutboundContext implements OutboundContextCapability {
  constructor(
    private service: OutboundContextService,
    private conversationId: string,
  ) {}

  async register(entry: Omit<OutboundContextEntry, 'conversationId'>): Promise<string> {
    return this.service.register({ ...entry, conversationId: this.conversationId });
  }

  async release(entryId: string): Promise<void> {
    return this.service.release(entryId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix . vitest run src/dispatch/outbound-context.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/outbound-context.ts src/dispatch/outbound-context.test.ts
git commit -m "feat: add OutboundContextService and ScopedOutboundContext (#615)"
```

---

## Task 3: Wire the `outboundContext` capability into the framework

**Files:**
- Modify: `src/skills/loader.ts` (line 27 — `VALID_CAPABILITIES` set)
- Modify: `src/skills/types.ts` (line ~221 — `SkillContext` interface, line ~59 — capability docstring)
- Modify: `src/skills/execution.ts` (lines ~528-553 — `capabilityServices` map, lines ~599-642 — injection loop, constructor options type)

- [ ] **Step 1: Add `outboundContext` to the valid capabilities set**

In `src/skills/loader.ts`, add `'outboundContext'` to the `VALID_CAPABILITIES` set:

```typescript
// Find the existing set (around line 27):
export const VALID_CAPABILITIES: ReadonlySet<string> = new Set([
  'bus', 'agentRegistry', 'outboundGateway', 'heldMessages',
  'schedulerService', 'entityMemory', 'nylasCalendarClient',
  'autonomyService', 'executiveProfileService', 'browserService', 'bullpenService', 'skillSearch',
  'actionLogRepo', 'executionLayer', 'confidencePipeline', 'tempFileStore',
  'infraLlm', 'outboundContext',
]);
```

- [ ] **Step 2: Add `outboundContext` field to `SkillContext`**

In `src/skills/types.ts`, add after the `infraLlm?` field (around line 221):

```typescript
  /** Outbound context bridge — available to skills declaring 'outboundContext' in capabilities.
   *  Provides a narrow surface (register + release) for managing outbound context bridge entries.
   *  Pre-scoped with conversationId by the execution layer. */
  outboundContext?: import('../dispatch/outbound-context.js').OutboundContextCapability;
```

Also update the capability docstring in `SkillManifest` (around line 59) to include `outboundContext` in the valid capabilities list:

```text
   *  Valid capabilities: bus, agentRegistry, outboundGateway, heldMessages,
   *  schedulerService, entityMemory, nylasCalendarClient, autonomyService,
   *  executiveProfileService, browserService, bullpenService, skillSearch,
   *  actionLogRepo, executionLayer, confidencePipeline, tempFileStore,
   *  infraLlm, outboundContext.
```

- [ ] **Step 3: Add `outboundContextService` to ExecutionLayer**

In `src/skills/execution.ts`:

**3a.** Add the import at the top of the file:

```typescript
import { OutboundContextService, ScopedOutboundContext } from '../dispatch/outbound-context.js';
```

**3b.** Add to the constructor options type (find the options interface or inline type — look for where `infraLlmService` is declared as a constructor option):

```typescript
outboundContextService?: OutboundContextService;
```

**3c.** Add private field:

```typescript
private outboundContextService?: OutboundContextService;
```

**3d.** Set it in the constructor body:

```typescript
this.outboundContextService = options.outboundContextService;
```

**3e.** Add to `capabilityServices` map (around line 553, after the `infraLlm` entry):

```typescript
outboundContext: this.outboundContextService,
```

**3f.** Add a special-case branch in the capability injection loop (after the `infraLlm` branch, around line 631):

```typescript
} else if (cap === 'outboundContext') {
  // Scoped instance: pre-fills conversationId so skills don't need it.
  if (this.outboundContextService && options?.conversationId) {
    ctx.outboundContext = new ScopedOutboundContext(
      this.outboundContextService,
      options.conversationId,
    );
  }
```

- [ ] **Step 4: Verify compilation**

Run: `npx --prefix . tsc --noEmit`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/skills/loader.ts src/skills/types.ts src/skills/execution.ts
git commit -m "feat: wire outboundContext capability into skill framework (#615)"
```

---

## Task 4: Wire OutboundContextService into bootstrap

**Files:**
- Modify: `src/index.ts` (around lines 1142 and 1150 and 1418)

- [ ] **Step 1: Import OutboundContextService**

At the top of `src/index.ts`, add:

```typescript
import { OutboundContextService } from './dispatch/outbound-context.js';
```

- [ ] **Step 2: Instantiate the service**

After the `infraLlmService` construction (around line 1143) and before `ExecutionLayer` construction (around line 1150), add:

```typescript
// Outbound context bridge — delegation-aware context registry for
// specialist-initiated outbound. Requires pool (Postgres).
const outboundContextService = pool
  ? new OutboundContextService(pool, logger)
  : undefined;
```

- [ ] **Step 3: Pass to ExecutionLayer**

In the `ExecutionLayer` constructor call (around line 1150), add `outboundContextService` to the options object:

```typescript
const executionLayer = new ExecutionLayer(skillRegistry, logger, {
  // ... existing options ...
  outboundContextService,
});
```

- [ ] **Step 4: Pass to Dispatcher**

In the `Dispatcher` constructor call (around line 1418), add `outboundContextService`:

```typescript
const dispatcher = new Dispatcher({
  // ... existing options ...
  outboundContextService,
});
```

(The dispatcher integration happens in Task 8. This just threads the service instance through. The dispatcher will ignore it until it's wired into `handleInbound`.)

- [ ] **Step 5: Verify compilation**

Run: `npx --prefix . tsc --noEmit`

Expected: A type error about `outboundContextService` not being in `DispatcherConfig` — that's expected and will be fixed in Task 8. As long as there are no other errors, proceed.

If the type error blocks compilation, temporarily add the field to `DispatcherConfig` (in `src/dispatch/dispatcher.ts`):

```typescript
outboundContextService?: import('./outbound-context.js').OutboundContextService;
```

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/dispatch/dispatcher.ts
git commit -m "feat: wire OutboundContextService into bootstrap (#615)"
```

---

## Task 5: Update `signal-send` with `context_bridge` support

**Files:**
- Modify: `skills/signal-send/skill.json`
- Modify: `skills/signal-send/handler.ts`
- Modify: `skills/signal-send/handler.test.ts`

- [ ] **Step 1: Write the failing tests**

Add the following test cases to `skills/signal-send/handler.test.ts`:

```typescript
describe('context_bridge', () => {
  it('registers a context bridge entry after successful 1:1 send', async () => {
    const ctx = makeCtx({
      recipient: '+14155551234',
      message: 'Any takeaways?',
      context_bridge: JSON.stringify({
        agent_id: 'meeting-debrief',
        expected_reply: 'Meeting notes',
        delegation_hint: 'Delegate to meeting-debrief',
        metadata: { meeting: 'sync' },
        expires_in_hours: 48,
      }),
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'msg-1',
    });
    const mockRegister = vi.fn().mockResolvedValue('entry-1');
    (ctx as Record<string, unknown>).outboundContext = { register: mockRegister, release: vi.fn() };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(mockRegister).toHaveBeenCalledWith({
      channelId: 'signal',
      agentId: 'meeting-debrief',
      content: 'Any takeaways?',
      expectedReply: 'Meeting notes',
      delegationHint: 'Delegate to meeting-debrief',
      metadata: { meeting: 'sync' },
      expiresInHours: 48,
    });
  });

  it('does not register when context_bridge is absent', async () => {
    const ctx = makeCtx({
      recipient: '+14155551234',
      message: 'Hello',
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'msg-1',
    });
    const mockRegister = vi.fn();
    (ctx as Record<string, unknown>).outboundContext = { register: mockRegister, release: vi.fn() };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('does not register when send fails', async () => {
    const ctx = makeCtx({
      recipient: '+14155551234',
      message: 'Hello',
      context_bridge: JSON.stringify({ agent_id: 'coordinator' }),
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false, blockedReason: 'Blocked',
    });
    const mockRegister = vi.fn();
    (ctx as Record<string, unknown>).outboundContext = { register: mockRegister, release: vi.fn() };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('logs a warning but succeeds when context bridge registration fails', async () => {
    const ctx = makeCtx({
      recipient: '+14155551234',
      message: 'Hello',
      context_bridge: JSON.stringify({ agent_id: 'coordinator' }),
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'msg-1',
    });
    const mockRegister = vi.fn().mockRejectedValue(new Error('DB down'));
    (ctx as Record<string, unknown>).outboundContext = { register: mockRegister, release: vi.fn() };

    const result = await handler.execute(ctx);

    // Send succeeds even though bridge registration failed
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix . vitest run skills/signal-send/handler.test.ts`

Expected: new tests FAIL — `context_bridge` is not handled yet.

- [ ] **Step 3: Update the handler implementation**

In `skills/signal-send/handler.ts`, add a helper interface and function at the top (after imports):

```typescript
interface ContextBridgeInput {
  agent_id: string;
  expected_reply?: string;
  delegation_hint?: string;
  metadata?: Record<string, unknown>;
  expires_in_hours?: number;
}

function parseContextBridge(raw: unknown): ContextBridgeInput | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as ContextBridgeInput;
  } catch {
    return null;
  }
}
```

Then, in the `execute` method, extract `context_bridge` from input alongside existing fields:

```typescript
const { recipient, group_id, message, context_bridge: contextBridgeRaw } = ctx.input as {
  recipient?: string;
  group_id?: string;
  message?: string;
  context_bridge?: string;
};
```

After each successful `return { success: true, data: ... }` (there are two — one for group sends at ~line 140, one for 1:1 sends at ~line 167), insert context bridge registration BEFORE the return. Both paths follow the same pattern:

```typescript
    // Register context bridge entry if requested (best-effort).
    const bridge = parseContextBridge(contextBridgeRaw);
    if (bridge && ctx.outboundContext) {
      try {
        await ctx.outboundContext.register({
          channelId: 'signal',
          agentId: bridge.agent_id,
          content: message,
          ...(bridge.expected_reply != null ? { expectedReply: bridge.expected_reply } : {}),
          ...(bridge.delegation_hint != null ? { delegationHint: bridge.delegation_hint } : {}),
          ...(bridge.metadata != null ? { metadata: bridge.metadata } : {}),
          ...(bridge.expires_in_hours != null ? { expiresInHours: bridge.expires_in_hours } : {}),
        });
      } catch (err) {
        ctx.log.warn({ err }, 'signal-send: failed to register context bridge entry — send succeeded');
      }
    }

    return { success: true, data: { delivered_to: recipient ?? group_id, channel: 'signal' } };
```

**Important:** This code must appear AFTER the `outboundGateway.send()` call succeeds and BEFORE the `return` statement, in both the group-send path and the 1:1 path. Optional fields use conditional spread (`!= null`) so undefined values aren't passed to `register()` — this keeps test assertions clean and avoids passing noise to the service.

- [ ] **Step 4: Update skill.json**

In `skills/signal-send/skill.json`:

Add `context_bridge` to `inputs`:

```json
"inputs": {
  "recipient": "string?",
  "group_id": "string?",
  "message": "string",
  "context_bridge": "string? (JSON — optional context bridge registration: {agent_id, expected_reply?, delegation_hint?, metadata?, expires_in_hours?})"
}
```

Add `outboundContext` to `capabilities`:

```json
"capabilities": [
  "outboundGateway",
  "outboundContext"
]
```

Bump version to `"1.1.0"`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx --prefix . vitest run skills/signal-send/handler.test.ts`

Expected: all tests PASS (including existing tests — no regressions).

- [ ] **Step 6: Commit**

```bash
git add skills/signal-send/
git commit -m "feat: add context_bridge support to signal-send skill (#615)"
```

---

## Task 6: Update `email-send` with `context_bridge` support

**Files:**
- Modify: `skills/email-send/skill.json`
- Modify: `skills/email-send/handler.ts`
- Modify: `skills/email-send/handler.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `skills/email-send/handler.test.ts`:

```typescript
describe('context_bridge', () => {
  it('registers a context bridge entry after successful send', async () => {
    const ctx = makeCtx({
      to: 'alice@example.com',
      subject: 'Meeting follow-up',
      body: 'Any thoughts on the proposal?',
      context_bridge: JSON.stringify({
        agent_id: 'meeting-debrief',
        expected_reply: 'Proposal feedback',
        delegation_hint: 'Delegate to meeting-debrief',
        expires_in_hours: 72,
      }),
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'msg-1',
    });
    const mockRegister = vi.fn().mockResolvedValue('entry-1');
    (ctx as Record<string, unknown>).outboundContext = { register: mockRegister, release: vi.fn() };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(mockRegister).toHaveBeenCalledWith({
      channelId: 'email',
      agentId: 'meeting-debrief',
      content: 'Any thoughts on the proposal?',
      expectedReply: 'Proposal feedback',
      delegationHint: 'Delegate to meeting-debrief',
      expiresInHours: 72,
    });
  });

  it('does not register when context_bridge is absent', async () => {
    const ctx = makeCtx({
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'Hi there',
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'msg-1',
    });
    const mockRegister = vi.fn();
    (ctx as Record<string, unknown>).outboundContext = { register: mockRegister, release: vi.fn() };

    await handler.execute(ctx);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('logs warning but succeeds when bridge registration fails', async () => {
    const ctx = makeCtx({
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'Hi there',
      context_bridge: JSON.stringify({ agent_id: 'coordinator' }),
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'msg-1',
    });
    const mockRegister = vi.fn().mockRejectedValue(new Error('DB error'));
    (ctx as Record<string, unknown>).outboundContext = { register: mockRegister, release: vi.fn() };

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix . vitest run skills/email-send/handler.test.ts`

- [ ] **Step 3: Update the handler**

In `skills/email-send/handler.ts`:

Add the same `ContextBridgeInput` interface and `parseContextBridge` helper as in signal-send (identical code).

Extract `context_bridge` from input:

```typescript
const { to, cc, subject, body, context_bridge: contextBridgeRaw } = ctx.input as {
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  context_bridge?: string;
};
```

After the successful `outboundGateway.send()` call and before the success return (around line 110), add:

```typescript
      // Register context bridge entry if requested (best-effort).
      const bridge = parseContextBridge(contextBridgeRaw);
      if (bridge && ctx.outboundContext) {
        try {
          await ctx.outboundContext.register({
            channelId: 'email',
            agentId: bridge.agent_id,
            content: body,
            ...(bridge.expected_reply != null ? { expectedReply: bridge.expected_reply } : {}),
            ...(bridge.delegation_hint != null ? { delegationHint: bridge.delegation_hint } : {}),
            ...(bridge.metadata != null ? { metadata: bridge.metadata } : {}),
            ...(bridge.expires_in_hours != null ? { expiresInHours: bridge.expires_in_hours } : {}),
          });
        } catch (err) {
          ctx.log.warn({ err }, 'email-send: failed to register context bridge entry — send succeeded');
        }
      }
```

- [ ] **Step 4: Update skill.json**

In `skills/email-send/skill.json`, add `context_bridge` to inputs:

```json
"context_bridge": "string? (JSON — optional context bridge registration)"
```

Add `outboundContext` to capabilities:

```json
"capabilities": [
  "outboundGateway",
  "outboundContext"
]
```

Bump version to `"1.1.0"`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx --prefix . vitest run skills/email-send/handler.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/email-send/
git commit -m "feat: add context_bridge support to email-send skill (#615)"
```

---

## Task 7: Update `email-reply` with `context_bridge` support

**Files:**
- Modify: `skills/email-reply/skill.json`
- Modify: `skills/email-reply/handler.ts`
- Modify: `skills/email-reply/handler.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `skills/email-reply/handler.test.ts`:

```typescript
describe('context_bridge', () => {
  it('registers a context bridge entry after successful reply', async () => {
    const ctx = makeCtx({
      reply_to_message_id: 'nylas-msg-1',
      body: 'Thanks for the update — any next steps?',
      context_bridge: JSON.stringify({
        agent_id: 'coordinator',
        expected_reply: 'Next steps or action items',
        expires_in_hours: 24,
      }),
    });
    // Mock getEmailMessage to return original message details
    (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: [{ email: 'alice@example.com' }],
      to: [],
      cc: [],
      subject: 'Project update',
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'reply-1',
    });
    const mockRegister = vi.fn().mockResolvedValue('entry-1');
    (ctx as Record<string, unknown>).outboundContext = { register: mockRegister, release: vi.fn() };

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(mockRegister).toHaveBeenCalledWith({
      channelId: 'email',
      agentId: 'coordinator',
      content: 'Thanks for the update — any next steps?',
      expectedReply: 'Next steps or action items',
      expiresInHours: 24,
    });
  });

  it('does not register when context_bridge is absent', async () => {
    const ctx = makeCtx({
      reply_to_message_id: 'nylas-msg-1',
      body: 'Got it, thanks',
    });
    (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: [{ email: 'alice@example.com' }],
      to: [],
      cc: [],
      subject: 'Quick note',
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'reply-1',
    });
    const mockRegister = vi.fn();
    (ctx as Record<string, unknown>).outboundContext = { register: mockRegister, release: vi.fn() };

    await handler.execute(ctx);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('logs warning but succeeds when bridge registration fails', async () => {
    const ctx = makeCtx({
      reply_to_message_id: 'nylas-msg-1',
      body: 'Sounds good',
      context_bridge: JSON.stringify({ agent_id: 'coordinator' }),
    });
    (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: [{ email: 'alice@example.com' }],
      to: [],
      cc: [],
      subject: 'Plan',
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'reply-1',
    });
    const mockRegister = vi.fn().mockRejectedValue(new Error('DB error'));
    (ctx as Record<string, unknown>).outboundContext = { register: mockRegister, release: vi.fn() };

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix . vitest run skills/email-reply/handler.test.ts`

- [ ] **Step 3: Update the handler**

In `skills/email-reply/handler.ts`:

Add the same `ContextBridgeInput` interface and `parseContextBridge` helper.

Extract `context_bridge` from input:

```typescript
const { reply_to_message_id: replyToMessageId, body, cc: ccInput, context_bridge: contextBridgeRaw } = ctx.input as {
  reply_to_message_id?: string;
  body?: string;
  cc?: string;
  context_bridge?: string;
};
```

After the successful `outboundGateway.send()` call (around line 120) and before the success return, add:

```typescript
      // Register context bridge entry if requested (best-effort).
      const bridge = parseContextBridge(contextBridgeRaw);
      if (bridge && ctx.outboundContext) {
        try {
          await ctx.outboundContext.register({
            channelId: 'email',
            agentId: bridge.agent_id,
            content: body,
            ...(bridge.expected_reply != null ? { expectedReply: bridge.expected_reply } : {}),
            ...(bridge.delegation_hint != null ? { delegationHint: bridge.delegation_hint } : {}),
            ...(bridge.metadata != null ? { metadata: bridge.metadata } : {}),
            ...(bridge.expires_in_hours != null ? { expiresInHours: bridge.expires_in_hours } : {}),
          });
        } catch (err) {
          ctx.log.warn({ err }, 'email-reply: failed to register context bridge entry — reply succeeded');
        }
      }
```

- [ ] **Step 4: Update skill.json**

In `skills/email-reply/skill.json`, add `context_bridge` to inputs:

```json
"context_bridge": "string? (JSON — optional context bridge registration)"
```

Add `outboundContext` to capabilities:

```json
"capabilities": [
  "outboundGateway",
  "outboundContext"
]
```

Bump version to `"1.2.0"`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx --prefix . vitest run skills/email-reply/handler.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/email-reply/
git commit -m "feat: add context_bridge support to email-reply skill (#615)"
```

---

## Task 8: Create `context-bridge-release` skill

**Files:**
- Create: `skills/context-bridge-release/skill.json`
- Create: `skills/context-bridge-release/handler.ts`
- Create: `skills/context-bridge-release/handler.test.ts`
- Modify: `agents/coordinator.yaml` (add to `pinned_skills`)

- [ ] **Step 1: Write the test file**

```typescript
// skills/context-bridge-release/handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ContextBridgeReleaseHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import pino from 'pino';

const handler = new ContextBridgeReleaseHandler();

function makeCtx(input: Record<string, unknown>): SkillContext {
  return {
    input,
    secret: vi.fn(),
    log: pino({ level: 'silent' }),
    outboundContext: {
      register: vi.fn(),
      release: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as SkillContext;
}

describe('ContextBridgeReleaseHandler', () => {
  it('calls release with the provided entry_id', async () => {
    const ctx = makeCtx({ entry_id: 'abc-123' });
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.outboundContext!.release).toHaveBeenCalledWith('abc-123');
  });

  it('returns error when entry_id is missing', async () => {
    const ctx = makeCtx({});
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/entry_id/);
    }
  });

  it('returns error when outboundContext capability is missing', async () => {
    const ctx = makeCtx({ entry_id: 'abc-123' });
    (ctx as Record<string, unknown>).outboundContext = undefined;

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/outboundContext/);
    }
  });

  it('returns error when release throws', async () => {
    const ctx = makeCtx({ entry_id: 'abc-123' });
    (ctx.outboundContext!.release as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB error'),
    );

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/Failed to release/);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix . vitest run skills/context-bridge-release/handler.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the handler**

```typescript
// skills/context-bridge-release/handler.ts
//
// Marks an outbound context bridge entry as released — stops expecting replies
// for that outbound message. Coordinator-only (enforced by allowed_callers).

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ContextBridgeReleaseHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { entry_id: entryId } = ctx.input as { entry_id?: string };

    if (!entryId || typeof entryId !== 'string') {
      return { success: false, error: 'Missing required input: entry_id (string)' };
    }

    if (!ctx.outboundContext) {
      return {
        success: false,
        error: 'context-bridge-release requires outboundContext capability.',
      };
    }

    try {
      await ctx.outboundContext.release(entryId);
      ctx.log.info({ entryId }, 'Context bridge entry released');
      return { success: true, data: { released: entryId } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, entryId }, 'Failed to release context bridge entry');
      return { success: false, error: `Failed to release context bridge entry: ${message}` };
    }
  }
}
```

- [ ] **Step 4: Write skill.json**

```json
{
  "name": "context-bridge-release",
  "description": "Mark an outbound context bridge entry as released — stop expecting replies for this outbound message. Use this when a delegated conversation is complete or when you want to clear stale context. The entry_id is shown in the [ACTIVE OUTBOUND CONTEXT] block.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "inputs": {
    "entry_id": "string"
  },
  "outputs": {
    "released": "string"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000,
  "capabilities": [
    "outboundContext"
  ],
  "allowed_callers": [
    "coordinator"
  ]
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx --prefix . vitest run skills/context-bridge-release/handler.test.ts`

Expected: all tests PASS.

- [ ] **Step 6: Pin to coordinator**

In `agents/coordinator.yaml`, add `context-bridge-release` to the `pinned_skills` list. Find the list (starts around line 490) and add the entry after `signal-send` (keeping outbound-related skills grouped):

```yaml
    - context-bridge-release
```

- [ ] **Step 7: Commit**

```bash
git add skills/context-bridge-release/ agents/coordinator.yaml
git commit -m "feat: add context-bridge-release skill, coordinator-only (#615)"
```

---

## Task 9: Update dispatcher read path — inject from OutboundContextService

**Files:**
- Modify: `src/dispatch/dispatcher.ts` (DispatcherConfig + constructor + handleInbound read path)
- Modify: `tests/unit/dispatch/dispatcher-context-bridging.test.ts`

- [ ] **Step 1: Write the updated test for the new read path**

Rewrite `tests/unit/dispatch/dispatcher-context-bridging.test.ts` to test the v2 flow. Replace the existing file contents with:

```typescript
// tests/unit/dispatch/dispatcher-context-bridging.test.ts
//
// Tests the v2 context bridging flow: OutboundContextService-backed injection
// into coordinator tasks on inbound messages.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundContextService } from '../../../src/dispatch/outbound-context.js';
import type { OutboundContextRow } from '../../../src/dispatch/outbound-context.js';
import type { DbPool } from '../../../src/db/connection.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makePool() {
  return { query: vi.fn() } as unknown as DbPool;
}

function makeActiveEntry(overrides: Partial<OutboundContextRow> = {}): OutboundContextRow {
  return {
    id: 'entry-1',
    conversationId: 'conv-1',
    channelId: 'signal',
    agentId: 'meeting-debrief',
    contentPreview: 'Any takeaways from the meeting?',
    expectedReply: 'Meeting notes',
    delegationHint: 'Delegate to meeting-debrief',
    metadata: { meeting: 'Strategy sync' },
    createdAt: new Date(Date.now() - 5 * 60 * 1000),
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    released: false,
    ...overrides,
  };
}

describe('OutboundContextService integration (read path)', () => {
  let pool: ReturnType<typeof makePool>;
  let service: OutboundContextService;

  beforeEach(() => {
    pool = makePool();
    service = new OutboundContextService(pool, logger);
  });

  it('formatInjectionBlock produces injection when active entries exist', () => {
    const entries = [makeActiveEntry()];
    const result = service.formatInjectionBlock(entries, 'Hello from CEO');

    expect(result).not.toBeNull();
    expect(result).toContain('[ACTIVE OUTBOUND CONTEXT');
    expect(result).toContain('entry_id: entry-1');
    expect(result).toContain('on behalf of meeting-debrief');
    expect(result).toContain('Hello from CEO');
  });

  it('formatInjectionBlock returns null when no entries', () => {
    const result = service.formatInjectionBlock([], 'Hello');
    expect(result).toBeNull();
  });

  it('getActive queries only non-released, non-expired entries', async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await service.getActive();

    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain('released = false');
    expect(sql).toContain('expires_at > now()');
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass against the existing service**

Run: `npx --prefix . vitest run tests/unit/dispatch/dispatcher-context-bridging.test.ts`

Expected: PASS — these test the service directly, which already exists.

- [ ] **Step 3: Update DispatcherConfig and constructor**

In `src/dispatch/dispatcher.ts`:

**3a.** Add import at top:

```typescript
import type { OutboundContextService } from './outbound-context.js';
```

**3b.** In `DispatcherConfig` interface, add (and update the comment for `workingMemory`):

```typescript
  /** Outbound context service — v2 context bridging. When present, replaces
   *  the working-memory-based context memo injection. */
  outboundContextService?: OutboundContextService;
```

**3c.** Add private field:

```typescript
private outboundContextService?: OutboundContextService;
```

**3d.** In the constructor, set it:

```typescript
this.outboundContextService = config.outboundContextService;
```

- [ ] **Step 4: Replace the read path in handleInbound**

Find the existing read path block (around lines 600-625):

```typescript
    if (this.workingMemory && inboundPolicy && !inboundPolicy.threaded) {
      try {
        const history = await this.workingMemory.getHistory(
          payload.conversationId, 'coordinator',
        );
        const recentMemos = extractRecentMemos(history, this.contextMemoTtlMs);
        const preamble = buildContextPreamble(recentMemos, taskContent);
        if (preamble !== null) {
          taskContent = preamble;
          // ...
        }
      } catch (err) {
        // ...
      }
    }
```

Replace with:

```typescript
    // Context bridging v2: inject active outbound context entries.
    // Unlike v1 (which only applied to non-threaded channels), v2 injects for all
    // inbound messages — the LLM judges relevance across channels.
    if (this.outboundContextService) {
      try {
        const activeEntries = await this.outboundContextService.getActive();
        const preamble = this.outboundContextService.formatInjectionBlock(activeEntries, taskContent);
        if (preamble !== null) {
          taskContent = preamble;
          this.logger.debug(
            { channelId: payload.channelId, conversationId: payload.conversationId, entryCount: activeEntries.length },
            'Injected active outbound context into task content',
          );
        }
      } catch (err) {
        this.logger.warn(
          { err, channelId: payload.channelId, conversationId: payload.conversationId },
          'Failed to read outbound context entries — proceeding without context injection',
        );
      }
    }
```

- [ ] **Step 5: Verify compilation**

Run: `npx --prefix . tsc --noEmit`

Expected: no errors.

- [ ] **Step 6: Run all tests**

Run: `npx --prefix . vitest run tests/unit/dispatch/`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/dispatch/dispatcher.ts tests/unit/dispatch/dispatcher-context-bridging.test.ts
git commit -m "feat: replace context-memo read path with OutboundContextService (#615)"
```

---

## Task 10: Remove dispatcher write path and delete context-memo.ts

**Files:**
- Modify: `src/dispatch/dispatcher.ts` (remove write path + unused imports)
- Delete: `src/dispatch/context-memo.ts`
- Delete: `tests/unit/dispatch/context-memo.test.ts`

- [ ] **Step 1: Remove the write path from handleAgentResponse**

In `src/dispatch/dispatcher.ts`, find the write path block (around lines 880-906):

```typescript
    // Write an outbound context memo to working memory for non-threaded channels.
    // ...
    const channelPolicy = this.channelPolicies?.[routing.channelId];
    if (this.workingMemory && channelPolicy && !channelPolicy.threaded) {
      try {
        const memo = formatOutboundMemo({
          // ...
        });
        await this.workingMemory.addTurn(routing.conversationId, 'coordinator', {
          role: 'system',
          content: memo,
        });
        // ...
      } catch (err) {
        // ...
      }
    }
```

Delete this entire block.

- [ ] **Step 2: Remove unused imports from dispatcher.ts**

Remove the context-memo import:

```typescript
// Delete this line:
import { formatOutboundMemo, extractRecentMemos, buildContextPreamble } from './context-memo.js';
```

If `workingMemory` and `contextMemoTtlMs` are no longer used anywhere in the file (search for all references), also:
- Remove the `WorkingMemory` import
- Remove `workingMemory` and `contextMemoTtlMs` from `DispatcherConfig` interface
- Remove the corresponding private fields and constructor assignments

**Check first** — `workingMemory` may still be used for actual conversation memory elsewhere in the dispatcher. Only remove if it was exclusively used for context memos.

- [ ] **Step 3: Delete context-memo.ts and its tests**

Delete:
- `src/dispatch/context-memo.ts`
- `tests/unit/dispatch/context-memo.test.ts`

- [ ] **Step 4: Verify compilation**

Run: `npx --prefix . tsc --noEmit`

Expected: no errors. If there are errors about missing `context-memo.js` imports elsewhere, fix them.

- [ ] **Step 5: Run full test suite**

Run: `npx --prefix . vitest run`

Expected: all tests PASS. Some tests may need updating if they imported from `context-memo.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: remove v1 context-memo write path and delete context-memo.ts (#615)"
```

---

## Task 11: Update coordinator prompt

**Files:**
- Modify: `agents/coordinator.yaml` (outbound context section, around lines 198-214)

- [ ] **Step 1: Replace the outbound context section**

Find the existing section (around lines 198-214):

```yaml
  ## Outbound context
  When your input includes a [PRIOR OUTBOUND CONTEXT] section, the user is likely
  replying to that prior message. Use the context memo (message_preview, key_ids,
  expected_reply) to understand what they are referring to and act accordingly.

  When your input does NOT include a [PRIOR OUTBOUND CONTEXT] section, apply this
  two-part test:
  ...
```

Replace with:

```yaml
  ## Active Outbound Context & Delegation
  When your input includes an [ACTIVE OUTBOUND CONTEXT] section, these are messages
  you previously sent that may receive replies. For each entry:

  - Check if the inbound message plausibly relates to one of the active entries
  - If it does, delegate to the specialist named in the delegation hint, including
    the CEO's message and relevant context from the entry
  - If the message is clearly about something else, handle it normally — entries
    are advisory, not binding
  - When a delegated task completes and the conversation is done, release the
    context entry using context-bridge-release (pass the entry_id shown in the block)

  If no [ACTIVE OUTBOUND CONTEXT] section is present, apply this two-part test:

  1. Is the message **self-contained** — fully actionable on its own?
     Examples: "Move the weekly team meeting to 4:30", "What's on my calendar tomorrow?"
     → Proceed normally. No clarification needed.

  2. Is the message **reply-shaped** — only makes sense as a response to something prior?
     Examples: "Yes", "The second one", "Sounds good", "Go ahead"
     → Ask the user what they are referring to before acting.
     Keep it brief: "I lost the thread — what are you replying to?"
```

- [ ] **Step 2: Commit**

```bash
git add agents/coordinator.yaml
git commit -m "feat: update coordinator prompt for v2 context bridging delegation (#615)"
```

---

## Task 12: Update CHANGELOG.md

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entries under `## [Unreleased]`**

Add under the appropriate sections:

```markdown
### Added

- **`context-bridge-release`** — new coordinator skill to release outbound context entries when conversations complete. (#615)
- **`outbound_context` table** — dedicated Postgres table replaces working-memory memos for outbound context tracking. (#615)

### Changed

- **Context bridging v2** — outbound context registry replaces working-memory memos; send skills gain optional `context_bridge` param for delegation-aware reply routing. (#615)
- **Coordinator prompt** — `[PRIOR OUTBOUND CONTEXT]` replaced with `[ACTIVE OUTBOUND CONTEXT]` block including delegation guidance and entry IDs for release. (#615)
- **`signal-send`**, **`email-send`**, **`email-reply`** — accept optional `context_bridge` JSON param; declare `outboundContext` capability. (#615)

### Removed

- **`context-memo.ts`** — v1 context memo functions replaced by `OutboundContextService`. (#615)
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add context bridging v2 changelog entries (#615)"
```

---

## Task 13: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npx --prefix . vitest run`

Expected: all tests PASS.

- [ ] **Step 2: Type check**

Run: `npx --prefix . tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Verify migration numbering**

Run: `ls src/db/migrations/ | sort`

Verify `042_create_outbound_context.sql` has a unique prefix.

- [ ] **Step 4: Review all changes**

Run: `git log --oneline origin/main..HEAD`

Verify the commit history is clean and all commits reference #615.

---

## Parallelization Notes

Tasks 5, 6, and 7 (the three send skill updates) are independent and can be dispatched as parallel subagents. All other tasks must be sequential.

**Dependency graph:**
```text
1 (migration) → 2 (service) → 3 (capability wiring) → 4 (bootstrap)
                                                          ↓
                                              ┌──── 5 (signal-send)
                                              ├──── 6 (email-send)     ← parallel
                                              └──── 7 (email-reply)
                                                          ↓
                                              8 (context-bridge-release)
                                                          ↓
                                              9 (dispatcher read path)
                                                          ↓
                                              10 (remove write path + delete)
                                                          ↓
                                              11 (coordinator prompt)
                                                          ↓
                                              12 (CHANGELOG)
                                                          ↓
                                              13 (final verification)
```
