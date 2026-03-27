# Unknown Sender Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an unknown sender messages on any channel, hold their message, notify the CEO, and let the CEO identify or dismiss the sender — then replay the held message through the normal pipeline.

**Architecture:** A `held_messages` table stores messages from unknown senders. The dispatcher checks unknown sender policy per channel (from config) and either holds or drops the message instead of routing it to the coordinator. A new `held-messages` skill lets the coordinator list/process held messages. The CLI adapter shows immediate notifications for new held messages. The coordinator proactively mentions the oldest/most important held message when talking to the CEO.

**Tech Stack:** TypeScript/ESM, PostgreSQL (new migration), YAML config extension, vitest

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/db/migrations/007_create_held_messages.sql` | Held messages table |
| `src/contacts/held-messages.ts` | HeldMessageService — CRUD + replay logic |
| `src/contacts/unknown-sender-policy.ts` | Policy evaluation (per-channel config lookup) |
| `skills/held-messages-list/skill.json` | Manifest for listing held messages |
| `skills/held-messages-list/handler.ts` | Handler for listing held messages |
| `skills/held-messages-process/skill.json` | Manifest for processing a held message (identify/dismiss/block) |
| `skills/held-messages-process/handler.ts` | Handler for processing a held message |
| `tests/unit/contacts/held-messages.test.ts` | Unit tests for HeldMessageService |
| `tests/unit/contacts/unknown-sender-policy.test.ts` | Unit tests for policy evaluation |

### Modified files
| File | Changes |
|------|---------|
| `config/channel-trust.yaml` | Add `unknown_sender` policy per channel |
| `src/contacts/config-loader.ts` | Parse unknown_sender policy from channel-trust.yaml |
| `src/contacts/types.ts` | Add HeldMessage type, UnknownSenderPolicy type, extend AuthConfig |
| `src/dispatch/dispatcher.ts` | Check unknown sender policy, hold or drop instead of routing |
| `src/channels/cli/cli-adapter.ts` | Subscribe to `contact.unknown` for immediate CLI notification |
| `src/bus/events.ts` | Add `message.held` event type |
| `src/bus/permissions.ts` | Allow dispatch to publish `message.held`, system to subscribe |
| `src/index.ts` | Create HeldMessageService, pass to dispatcher and execution layer |
| `agents/coordinator.yaml` | Add held message awareness to prompt |

---

### Task 1: Types, Migration, and Config

**Files:**
- Modify: `src/contacts/types.ts`
- Create: `src/db/migrations/007_create_held_messages.sql`
- Modify: `config/channel-trust.yaml`
- Modify: `src/contacts/config-loader.ts`
- Modify: `tests/unit/contacts/config-loader.test.ts`

- [ ] **Step 1: Add types to `src/contacts/types.ts`**

Add at the end of the file:

```typescript
// -- Unknown sender policy --

export type UnknownSenderPolicy = 'allow' | 'hold_and_notify' | 'reject';

export type HeldMessageStatus = 'pending' | 'processed' | 'discarded';

export interface HeldMessage {
  id: string;
  channel: string;
  senderId: string;
  conversationId: string;
  content: string;
  subject: string | null;
  metadata: Record<string, unknown>;
  status: HeldMessageStatus;
  /** Contact ID if the CEO identified the sender */
  resolvedContactId: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface ChannelPolicyConfig {
  trust: TrustLevel;
  unknownSender: UnknownSenderPolicy;
}
```

Update `AuthConfig` to include the richer channel config:

```typescript
export interface AuthConfig {
  roles: Record<string, RolePermissions>;
  permissions: Record<string, PermissionDef>;
  channelTrust: Record<string, TrustLevel>;
  channelPolicies: Record<string, ChannelPolicyConfig>;
}
```

- [ ] **Step 2: Create migration `src/db/migrations/007_create_held_messages.sql`**

```sql
-- Up Migration

-- Held messages: stores inbound messages from unknown senders pending CEO review.
-- Messages stay here until the CEO identifies the sender (processed),
-- dismisses them (discarded), or they are auto-discarded by rate limiting.
CREATE TABLE held_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel             TEXT NOT NULL,
  sender_id           TEXT NOT NULL,
  conversation_id     TEXT NOT NULL,
  content             TEXT NOT NULL,
  subject             TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'pending',
  resolved_contact_id UUID REFERENCES contacts(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at        TIMESTAMPTZ
);

-- Index for listing pending messages (the primary query pattern)
CREATE INDEX idx_held_messages_status ON held_messages (status, created_at)
  WHERE status = 'pending';

-- Index for rate limiting: count pending messages per channel
CREATE INDEX idx_held_messages_channel_status ON held_messages (channel, status)
  WHERE status = 'pending';
```

- [ ] **Step 3: Update `config/channel-trust.yaml`**

Change from flat trust levels to richer policy config:

```yaml
# Channel trust and unknown sender policies.
# trust: determines max sensitivity of actions via this channel
# unknown_sender: what to do when a message arrives from an unrecognized sender
#   allow - process normally (CLI is always the CEO)
#   hold_and_notify - hold the message, notify CEO
#   reject - silently drop the message

channels:
  cli:
    trust: high
    unknown_sender: allow
  signal:
    trust: high
    unknown_sender: hold_and_notify
  telegram:
    trust: medium
    unknown_sender: hold_and_notify
  http:
    trust: medium
    unknown_sender: reject
  email:
    trust: low
    unknown_sender: hold_and_notify
```

- [ ] **Step 4: Update config loader to parse new format**

Read `src/contacts/config-loader.ts`. Update the channel trust parsing section to handle both the new object format and extract both `trust` and `unknownSender`:

```typescript
  // Channel trust levels and unknown sender policies
  const trustRaw = trustDoc as { channels: Record<string, string | { trust: string; unknown_sender: string }> };

  const channelTrust: Record<string, TrustLevel> = {};
  const channelPolicies: Record<string, ChannelPolicyConfig> = {};

  for (const [channel, config] of Object.entries(trustRaw.channels)) {
    if (typeof config === 'string') {
      // Backwards compat: plain string is just the trust level, default unknown_sender to 'hold_and_notify'
      const trust = config as TrustLevel;
      if (!['high', 'medium', 'low'].includes(trust)) {
        throw new Error(`Invalid trust level '${trust}' for channel '${channel}'`);
      }
      channelTrust[channel] = trust;
      channelPolicies[channel] = { trust, unknownSender: 'hold_and_notify' };
    } else {
      const trust = config.trust as TrustLevel;
      if (!['high', 'medium', 'low'].includes(trust)) {
        throw new Error(`Invalid trust level '${trust}' for channel '${channel}'`);
      }
      const unknownSender = config.unknown_sender as UnknownSenderPolicy;
      if (!['allow', 'hold_and_notify', 'reject'].includes(unknownSender)) {
        throw new Error(`Invalid unknown_sender policy '${unknownSender}' for channel '${channel}'`);
      }
      channelTrust[channel] = trust;
      channelPolicies[channel] = { trust, unknownSender };
    }
  }

  return { roles, permissions, channelTrust, channelPolicies };
```

Add imports for `UnknownSenderPolicy` and `ChannelPolicyConfig` from `./types.js`.

- [ ] **Step 5: Update config-loader tests**

Add to `tests/unit/contacts/config-loader.test.ts`:

```typescript
  it('loads unknown sender policies from YAML', () => {
    const config = loadAuthConfig(CONFIG_DIR);
    expect(config.channelPolicies).toBeDefined();
    expect(config.channelPolicies.cli.unknownSender).toBe('allow');
    expect(config.channelPolicies.email.unknownSender).toBe('hold_and_notify');
    expect(config.channelPolicies.http.unknownSender).toBe('reject');
  });

  it('preserves trust levels alongside policies', () => {
    const config = loadAuthConfig(CONFIG_DIR);
    expect(config.channelPolicies.cli.trust).toBe('high');
    expect(config.channelPolicies.email.trust).toBe('low');
    expect(config.channelTrust.cli).toBe('high');
  });
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/unit/contacts/config-loader.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/contacts/types.ts src/db/migrations/007_create_held_messages.sql config/channel-trust.yaml src/contacts/config-loader.ts tests/unit/contacts/config-loader.test.ts
git commit -m "feat: add held messages types, migration, and unknown sender config"
```

---

### Task 2: HeldMessageService

**Files:**
- Create: `src/contacts/held-messages.ts`
- Create: `tests/unit/contacts/held-messages.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/contacts/held-messages.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { HeldMessageService } from '../../../src/contacts/held-messages.js';

describe('HeldMessageService', () => {
  let service: HeldMessageService;

  beforeEach(() => {
    service = HeldMessageService.createInMemory();
  });

  it('holds a message and retrieves it', async () => {
    const id = await service.hold({
      channel: 'email',
      senderId: 'stranger@example.com',
      conversationId: 'email:thread-1',
      content: 'Can I get the Q3 numbers?',
      subject: 'Q3 Request',
      metadata: {},
    });

    const pending = await service.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id);
    expect(pending[0].senderId).toBe('stranger@example.com');
    expect(pending[0].status).toBe('pending');
  });

  it('lists pending messages for a specific channel', async () => {
    await service.hold({ channel: 'email', senderId: 'a@example.com', conversationId: 'e:1', content: 'test', subject: null, metadata: {} });
    await service.hold({ channel: 'telegram', senderId: '123', conversationId: 't:1', content: 'test', subject: null, metadata: {} });

    const emailOnly = await service.listPending('email');
    expect(emailOnly).toHaveLength(1);
    expect(emailOnly[0].channel).toBe('email');
  });

  it('marks a message as processed with contact ID', async () => {
    const id = await service.hold({ channel: 'email', senderId: 'a@example.com', conversationId: 'e:1', content: 'test', subject: null, metadata: {} });

    await service.markProcessed(id, 'contact-uuid-123');

    const pending = await service.listPending();
    expect(pending).toHaveLength(0);

    const msg = await service.getById(id);
    expect(msg?.status).toBe('processed');
    expect(msg?.resolvedContactId).toBe('contact-uuid-123');
    expect(msg?.processedAt).toBeInstanceOf(Date);
  });

  it('discards a message', async () => {
    const id = await service.hold({ channel: 'email', senderId: 'a@example.com', conversationId: 'e:1', content: 'test', subject: null, metadata: {} });

    await service.discard(id);

    const pending = await service.listPending();
    expect(pending).toHaveLength(0);

    const msg = await service.getById(id);
    expect(msg?.status).toBe('discarded');
  });

  it('enforces rate limit per channel', async () => {
    // Create a service with limit of 3 per channel
    const limited = HeldMessageService.createInMemory(3);

    await limited.hold({ channel: 'email', senderId: 'a@example.com', conversationId: 'e:1', content: '1', subject: null, metadata: {} });
    await limited.hold({ channel: 'email', senderId: 'b@example.com', conversationId: 'e:2', content: '2', subject: null, metadata: {} });
    await limited.hold({ channel: 'email', senderId: 'c@example.com', conversationId: 'e:3', content: '3', subject: null, metadata: {} });

    // This should discard the oldest
    await limited.hold({ channel: 'email', senderId: 'd@example.com', conversationId: 'e:4', content: '4', subject: null, metadata: {} });

    const pending = await limited.listPending('email');
    expect(pending).toHaveLength(3);
    // Oldest (a@) should be gone
    expect(pending.map(m => m.senderId)).not.toContain('a@example.com');
    expect(pending.map(m => m.senderId)).toContain('d@example.com');
  });

  it('rate limit is per channel, not global', async () => {
    const limited = HeldMessageService.createInMemory(2);

    await limited.hold({ channel: 'email', senderId: 'a@example.com', conversationId: 'e:1', content: '1', subject: null, metadata: {} });
    await limited.hold({ channel: 'email', senderId: 'b@example.com', conversationId: 'e:2', content: '2', subject: null, metadata: {} });
    await limited.hold({ channel: 'telegram', senderId: '111', conversationId: 't:1', content: '3', subject: null, metadata: {} });

    const emailPending = await limited.listPending('email');
    const telegramPending = await limited.listPending('telegram');
    expect(emailPending).toHaveLength(2);
    expect(telegramPending).toHaveLength(1);
  });

  it('returns null for non-existent message', async () => {
    const msg = await service.getById('non-existent-id');
    expect(msg).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/contacts/held-messages.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement HeldMessageService**

Create `src/contacts/held-messages.ts`:

```typescript
// src/contacts/held-messages.ts
//
// HeldMessageService: stores and manages messages from unknown senders
// that are held pending CEO review.
//
// Follows the backend-interface pattern (Postgres + InMemory).
// Rate limiting: max N pending messages per channel (default 20).
// When the cap is reached, the oldest pending message is auto-discarded.

import { randomUUID } from 'node:crypto';
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { HeldMessage, HeldMessageStatus } from './types.js';

// -- Hold options (what callers pass in) --

export interface HoldMessageOptions {
  channel: string;
  senderId: string;
  conversationId: string;
  content: string;
  subject: string | null;
  metadata: Record<string, unknown>;
}

// -- Backend interface --

interface HeldMessageBackend {
  insert(message: HeldMessage): Promise<void>;
  getById(id: string): Promise<HeldMessage | null>;
  listPending(channel?: string): Promise<HeldMessage[]>;
  countPendingByChannel(channel: string): Promise<number>;
  discardOldest(channel: string): Promise<void>;
  update(id: string, updates: Partial<Pick<HeldMessage, 'status' | 'resolvedContactId' | 'processedAt'>>): Promise<void>;
}

// Default max pending messages per channel
const DEFAULT_MAX_PER_CHANNEL = 20;

/**
 * HeldMessageService manages messages from unknown senders.
 *
 * When a message arrives from an unknown sender on a channel with
 * hold_and_notify policy, the dispatcher calls hold() to store it.
 * The CEO then reviews held messages and either identifies the sender
 * (markProcessed) or dismisses (discard).
 *
 * Rate limiting: max N pending messages per channel (configurable).
 * When the cap is reached, the oldest pending message is auto-discarded.
 *
 * TODO: Held message expiration/auto-discard timeout is deferred.
 * Messages are held indefinitely until the CEO acts. A future discard
 * process will need judgment and oversight — not a simple timer.
 */
export class HeldMessageService {
  private constructor(
    private backend: HeldMessageBackend,
    private maxPerChannel: number,
  ) {}

  static createWithPostgres(pool: DbPool, logger: Logger, maxPerChannel?: number): HeldMessageService {
    return new HeldMessageService(
      new PostgresHeldMessageBackend(pool, logger),
      maxPerChannel ?? DEFAULT_MAX_PER_CHANNEL,
    );
  }

  static createInMemory(maxPerChannel?: number): HeldMessageService {
    return new HeldMessageService(
      new InMemoryHeldMessageBackend(),
      maxPerChannel ?? DEFAULT_MAX_PER_CHANNEL,
    );
  }

  /**
   * Hold a message from an unknown sender.
   * Enforces per-channel rate limit — if at capacity, discards the oldest.
   * Returns the held message ID.
   */
  async hold(options: HoldMessageOptions): Promise<string> {
    // Rate limit: check if channel is at capacity
    const count = await this.backend.countPendingByChannel(options.channel);
    if (count >= this.maxPerChannel) {
      await this.backend.discardOldest(options.channel);
    }

    const message: HeldMessage = {
      id: randomUUID(),
      channel: options.channel,
      senderId: options.senderId,
      conversationId: options.conversationId,
      content: options.content,
      subject: options.subject,
      metadata: options.metadata,
      status: 'pending',
      resolvedContactId: null,
      createdAt: new Date(),
      processedAt: null,
    };

    await this.backend.insert(message);
    return message.id;
  }

  /** List pending held messages, optionally filtered by channel. */
  async listPending(channel?: string): Promise<HeldMessage[]> {
    return this.backend.listPending(channel);
  }

  /** Get a specific held message by ID. */
  async getById(id: string): Promise<HeldMessage | null> {
    return this.backend.getById(id);
  }

  /**
   * Mark a held message as processed (CEO identified the sender).
   * The contactId is the newly-created or existing contact for the sender.
   */
  async markProcessed(id: string, contactId: string): Promise<void> {
    await this.backend.update(id, {
      status: 'processed',
      resolvedContactId: contactId,
      processedAt: new Date(),
    });
  }

  /** Discard a held message (CEO dismissed it). */
  async discard(id: string): Promise<void> {
    await this.backend.update(id, {
      status: 'discarded',
      processedAt: new Date(),
    });
  }
}

// -- In-memory backend --

class InMemoryHeldMessageBackend implements HeldMessageBackend {
  private messages = new Map<string, HeldMessage>();

  async insert(message: HeldMessage): Promise<void> {
    this.messages.set(message.id, message);
  }

  async getById(id: string): Promise<HeldMessage | null> {
    return this.messages.get(id) ?? null;
  }

  async listPending(channel?: string): Promise<HeldMessage[]> {
    const all = [...this.messages.values()].filter(m => m.status === 'pending');
    if (channel) {
      return all.filter(m => m.channel === channel).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }
    return all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async countPendingByChannel(channel: string): Promise<number> {
    return [...this.messages.values()].filter(m => m.channel === channel && m.status === 'pending').length;
  }

  async discardOldest(channel: string): Promise<void> {
    const pending = [...this.messages.values()]
      .filter(m => m.channel === channel && m.status === 'pending')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (pending.length > 0) {
      this.messages.set(pending[0].id, { ...pending[0], status: 'discarded', processedAt: new Date() });
    }
  }

  async update(id: string, updates: Partial<Pick<HeldMessage, 'status' | 'resolvedContactId' | 'processedAt'>>): Promise<void> {
    const existing = this.messages.get(id);
    if (!existing) return;
    this.messages.set(id, { ...existing, ...updates });
  }
}

// -- Postgres backend --

class PostgresHeldMessageBackend implements HeldMessageBackend {
  constructor(private pool: DbPool, private logger: Logger) {}

  async insert(message: HeldMessage): Promise<void> {
    this.logger.debug({ id: message.id, channel: message.channel, senderId: message.senderId }, 'Inserting held message');
    await this.pool.query(
      `INSERT INTO held_messages (id, channel, sender_id, conversation_id, content, subject, metadata, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [message.id, message.channel, message.senderId, message.conversationId, message.content, message.subject, JSON.stringify(message.metadata), message.status, message.createdAt],
    );
  }

  async getById(id: string): Promise<HeldMessage | null> {
    const result = await this.pool.query<HeldMessageRow>(
      'SELECT * FROM held_messages WHERE id = $1',
      [id],
    );
    return result.rows[0] ? rowToHeldMessage(result.rows[0]) : null;
  }

  async listPending(channel?: string): Promise<HeldMessage[]> {
    if (channel) {
      const result = await this.pool.query<HeldMessageRow>(
        `SELECT * FROM held_messages WHERE status = 'pending' AND channel = $1 ORDER BY created_at ASC`,
        [channel],
      );
      return result.rows.map(rowToHeldMessage);
    }
    const result = await this.pool.query<HeldMessageRow>(
      `SELECT * FROM held_messages WHERE status = 'pending' ORDER BY created_at ASC`,
    );
    return result.rows.map(rowToHeldMessage);
  }

  async countPendingByChannel(channel: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM held_messages WHERE channel = $1 AND status = 'pending'`,
      [channel],
    );
    return parseInt(result.rows[0].count, 10);
  }

  async discardOldest(channel: string): Promise<void> {
    this.logger.debug({ channel }, 'Discarding oldest held message (rate limit reached)');
    await this.pool.query(
      `UPDATE held_messages SET status = 'discarded', processed_at = NOW()
       WHERE id = (
         SELECT id FROM held_messages
         WHERE channel = $1 AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1
       )`,
      [channel],
    );
  }

  async update(id: string, updates: Partial<Pick<HeldMessage, 'status' | 'resolvedContactId' | 'processedAt'>>): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      params.push(updates.status);
    }
    if (updates.resolvedContactId !== undefined) {
      setClauses.push(`resolved_contact_id = $${paramIndex++}`);
      params.push(updates.resolvedContactId);
    }
    if (updates.processedAt !== undefined) {
      setClauses.push(`processed_at = $${paramIndex++}`);
      params.push(updates.processedAt);
    }

    if (setClauses.length === 0) return;

    params.push(id);
    await this.pool.query(
      `UPDATE held_messages SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      params,
    );
  }
}

// -- Row types --

interface HeldMessageRow {
  id: string;
  channel: string;
  sender_id: string;
  conversation_id: string;
  content: string;
  subject: string | null;
  metadata: Record<string, unknown>;
  status: string;
  resolved_contact_id: string | null;
  created_at: Date;
  processed_at: Date | null;
}

function rowToHeldMessage(row: HeldMessageRow): HeldMessage {
  return {
    id: row.id,
    channel: row.channel,
    senderId: row.sender_id,
    conversationId: row.conversation_id,
    content: row.content,
    subject: row.subject,
    metadata: row.metadata,
    status: row.status as HeldMessageStatus,
    resolvedContactId: row.resolved_contact_id,
    createdAt: row.created_at,
    processedAt: row.processed_at,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/contacts/held-messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/contacts/held-messages.ts tests/unit/contacts/held-messages.test.ts
git commit -m "feat: add HeldMessageService with rate limiting"
```

---

### Task 3: Bus Events and Dispatcher Integration

**Files:**
- Modify: `src/bus/events.ts`
- Modify: `src/bus/permissions.ts`
- Modify: `src/dispatch/dispatcher.ts`
- Modify: `src/contacts/types.ts`

- [ ] **Step 1: Add `message.held` event to bus**

Read `src/bus/events.ts`. Add a new event type for held messages:

Payload:
```typescript
interface MessageHeldPayload {
  heldMessageId: string;
  channel: string;
  senderId: string;
  subject: string | null;
}
```

Event:
```typescript
export interface MessageHeldEvent extends BaseEvent {
  type: 'message.held';
  sourceLayer: 'dispatch';
  payload: MessageHeldPayload;
}
```

Add to the `BusEvent` union. Add a factory function `createMessageHeld`.

- [ ] **Step 2: Update permissions**

Read `src/bus/permissions.ts`. Add `'message.held'` to:
- dispatch publish allowlist
- system subscribe allowlist
- channel subscribe allowlist (so CLI adapter can show notifications)

- [ ] **Step 3: Update Dispatcher to check unknown sender policy**

Read `src/dispatch/dispatcher.ts`. The dispatcher needs:
- Access to the unknown sender policy config (channelPolicies)
- Access to the HeldMessageService

Update `DispatcherConfig`:
```typescript
export interface DispatcherConfig {
  bus: EventBus;
  logger: Logger;
  contactResolver?: ContactResolver;
  heldMessages?: HeldMessageService;
  channelPolicies?: Record<string, ChannelPolicyConfig>;
}
```

In `handleInbound`, after the contact resolver returns `UnknownSenderContext` (the `else` branch at line 90), check the policy:

```typescript
        } else {
          // Unknown sender — check channel policy
          await this.bus.publish('dispatch', createContactUnknown({
            channel: senderContext.channel,
            senderId: senderContext.senderId,
            parentEventId: event.id,
          }));

          const policy = this.channelPolicies?.[payload.channelId];
          if (policy?.unknownSender === 'hold_and_notify' && this.heldMessages) {
            // Hold the message instead of routing to coordinator
            const heldId = await this.heldMessages.hold({
              channel: payload.channelId,
              senderId: payload.senderId,
              conversationId: payload.conversationId,
              content: payload.content,
              subject: (payload.metadata as Record<string, unknown>)?.subject as string ?? null,
              metadata: payload.metadata ?? {},
            });

            // Publish held event so CLI can notify immediately
            await this.bus.publish('dispatch', createMessageHeld({
              heldMessageId: heldId,
              channel: payload.channelId,
              senderId: payload.senderId,
              subject: (payload.metadata as Record<string, unknown>)?.subject as string ?? null,
              parentEventId: event.id,
            }));

            this.logger.info(
              { heldMessageId: heldId, channel: payload.channelId, senderId: payload.senderId },
              'Message held from unknown sender',
            );
            return; // Do NOT route to coordinator
          }

          if (policy?.unknownSender === 'reject') {
            this.logger.info(
              { channel: payload.channelId, senderId: payload.senderId },
              'Rejected message from unknown sender',
            );
            return; // Silently drop
          }

          // 'allow' or no policy configured — fall through to normal routing
        }
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: PASS (existing tests may need updates if dispatcher constructor changed)

- [ ] **Step 5: Commit**

```bash
git add src/bus/events.ts src/bus/permissions.ts src/dispatch/dispatcher.ts
git commit -m "feat: dispatcher holds messages from unknown senders per channel policy"
```

---

### Task 4: CLI Notification

**Files:**
- Modify: `src/channels/cli/cli-adapter.ts`

- [ ] **Step 1: Subscribe CLI adapter to `message.held` events**

Read `src/channels/cli/cli-adapter.ts`. In the `start()` method, add a subscription for `message.held` events:

```typescript
    // Notify the CEO immediately when a message is held from an unknown sender.
    // This uses the channel layer's subscribe permission for message.held.
    this.bus.subscribe('message.held', 'channel', (event) => {
      if (event.type === 'message.held') {
        const held = event as MessageHeldEvent;
        const { senderId, channel, subject } = held.payload;
        const subjectLine = subject ? ` — "${subject}"` : '';
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`\n[Held] Unknown sender on ${channel}: ${senderId}${subjectLine}\n`);
        process.stdout.write('  Use "review held messages" to see details.\n\n');
        this.rl?.prompt();
      }
    });
```

Add the import for `MessageHeldEvent`.

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/channels/cli/cli-adapter.ts
git commit -m "feat: CLI shows immediate notification for held messages"
```

---

### Task 5: Held Message Skills

**Files:**
- Create: `skills/held-messages-list/skill.json`
- Create: `skills/held-messages-list/handler.ts`
- Create: `skills/held-messages-process/skill.json`
- Create: `skills/held-messages-process/handler.ts`
- Modify: `src/skills/types.ts`
- Modify: `src/skills/execution.ts`
- Modify: `agents/coordinator.yaml`

- [ ] **Step 1: Add heldMessages to SkillContext**

Read `src/skills/types.ts`. Add `heldMessages?: HeldMessageService` to the `SkillContext` interface (alongside the existing `contactService`, `bus`, etc.).

Read `src/skills/execution.ts`. In the infrastructure skill gate, inject `heldMessages`:
```typescript
      if (this.heldMessages) {
        ctx.heldMessages = this.heldMessages;
      }
```

Add `heldMessages` to the ExecutionLayer constructor options and store it.

- [ ] **Step 2: Create held-messages-list skill**

`skills/held-messages-list/skill.json`:
```json
{
  "name": "held-messages-list",
  "description": "List messages held from unknown senders awaiting your review. Shows sender, channel, subject, and when it arrived.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "channel": "string?"
  },
  "outputs": {
    "messages": "HeldMessage[]",
    "count": "number"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000
}
```

`skills/held-messages-list/handler.ts`:
```typescript
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class HeldMessagesListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.heldMessages) {
      return { success: false, error: 'Held messages service not available. Is infrastructure: true set?' };
    }

    const { channel } = ctx.input as { channel?: string };
    const filterChannel = (channel && typeof channel === 'string') ? channel : undefined;

    try {
      const messages = await ctx.heldMessages.listPending(filterChannel);
      const summary = messages.map(m => ({
        id: m.id,
        channel: m.channel,
        sender: m.senderId,
        subject: m.subject,
        preview: m.content.slice(0, 200),
        receivedAt: m.createdAt.toISOString(),
      }));

      ctx.log.info({ count: messages.length, channel: filterChannel ?? 'all' }, 'Listed held messages');
      return { success: true, data: { messages: summary, count: messages.length } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to list held messages: ${message}` };
    }
  }
}
```

- [ ] **Step 3: Create held-messages-process skill**

`skills/held-messages-process/skill.json`:
```json
{
  "name": "held-messages-process",
  "description": "Process a held message: identify the sender (create/link contact), dismiss it, or block the sender. After identifying, the message is replayed through normal processing.",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "infrastructure": true,
  "inputs": {
    "held_message_id": "string",
    "action": "string",
    "contact_name": "string?",
    "contact_role": "string?",
    "existing_contact_id": "string?"
  },
  "outputs": {
    "result": "string",
    "contact_id": "string?"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 30000
}
```

`skills/held-messages-process/handler.ts`:
```typescript
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createInboundMessage } from '../../src/bus/events.js';

export class HeldMessagesProcessHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { held_message_id, action, contact_name, contact_role, existing_contact_id } = ctx.input as {
      held_message_id?: string;
      action?: string;
      contact_name?: string;
      contact_role?: string;
      existing_contact_id?: string;
    };

    if (!held_message_id || typeof held_message_id !== 'string') {
      return { success: false, error: 'Missing required input: held_message_id (string)' };
    }
    if (!action || !['identify', 'dismiss', 'block'].includes(action)) {
      return { success: false, error: 'Invalid action — must be "identify", "dismiss", or "block"' };
    }
    if (!ctx.heldMessages || !ctx.contactService || !ctx.bus) {
      return { success: false, error: 'Required services not available. Is infrastructure: true set?' };
    }

    try {
      const heldMsg = await ctx.heldMessages.getById(held_message_id);
      if (!heldMsg) {
        return { success: false, error: `Held message not found: ${held_message_id}` };
      }
      if (heldMsg.status !== 'pending') {
        return { success: false, error: `Message already ${heldMsg.status}` };
      }

      if (action === 'dismiss') {
        await ctx.heldMessages.discard(held_message_id);
        ctx.log.info({ heldMessageId: held_message_id }, 'Held message dismissed');
        return { success: true, data: { result: 'dismissed' } };
      }

      if (action === 'block') {
        // Create a blocked contact for this sender
        const contact = await ctx.contactService.createContact({
          displayName: contact_name || heldMsg.senderId,
          status: 'blocked',
          source: 'ceo_stated',
        });
        await ctx.contactService.linkIdentity({
          contactId: contact.id,
          channel: heldMsg.channel,
          channelIdentifier: heldMsg.senderId,
          source: 'ceo_stated',
        });
        await ctx.heldMessages.discard(held_message_id);
        ctx.log.info({ heldMessageId: held_message_id, contactId: contact.id }, 'Sender blocked');
        return { success: true, data: { result: 'blocked', contact_id: contact.id } };
      }

      // action === 'identify'
      let contactId: string;

      if (existing_contact_id) {
        // Link to existing contact
        contactId = existing_contact_id;
        await ctx.contactService.linkIdentity({
          contactId,
          channel: heldMsg.channel,
          channelIdentifier: heldMsg.senderId,
          source: 'ceo_stated',
        });
      } else {
        // Create new confirmed contact
        if (!contact_name || typeof contact_name !== 'string') {
          return { success: false, error: 'contact_name is required when identifying a new sender' };
        }
        const contact = await ctx.contactService.createContact({
          displayName: contact_name,
          role: contact_role,
          status: 'confirmed',
          source: 'ceo_stated',
        });
        await ctx.contactService.linkIdentity({
          contactId: contact.id,
          channel: heldMsg.channel,
          channelIdentifier: heldMsg.senderId,
          source: 'ceo_stated',
        });
        contactId = contact.id;
      }

      // Mark as processed
      await ctx.heldMessages.markProcessed(held_message_id, contactId);

      // Replay the held message through normal processing.
      // Re-publish as inbound.message so it goes through the full pipeline
      // (contact resolution → authorization → coordinator) with the now-known sender.
      const replayEvent = createInboundMessage({
        conversationId: heldMsg.conversationId,
        channelId: heldMsg.channel,
        senderId: heldMsg.senderId,
        content: heldMsg.content,
        metadata: heldMsg.metadata,
      });
      await ctx.bus.publish('dispatch', replayEvent);

      ctx.log.info({ heldMessageId: held_message_id, contactId, action: 'identify' }, 'Sender identified, message replayed');
      return { success: true, data: { result: 'identified_and_replayed', contact_id: contactId } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to process held message: ${message}` };
    }
  }
}
```

- [ ] **Step 4: Add skills to coordinator**

Read `agents/coordinator.yaml`. Add to pinned_skills:
```yaml
  - held-messages-list
  - held-messages-process
```

Add held message guidance to the prompt (after the Authorization section):

```yaml
  ## Held Messages
  When unknown senders message on channels with hold_and_notify policy, their
  messages are held for your review. The CLI shows immediate notifications.

  When talking to the CEO:
  - Proactively mention the OLDEST held message if there are any pending.
    Don't list all of them — just mention one: "By the way, you have a held
    email from stranger@example.com about 'Q3 Numbers'. Want me to identify them?"
  - Use held-messages-list to show the CEO all pending messages when asked.
  - Use held-messages-process to handle each message:
    - "identify" — CEO tells you who the sender is. Creates a confirmed contact
      and replays the message through normal processing.
    - "dismiss" — CEO doesn't care about the message. Discards it.
    - "block" — CEO wants to block this sender. Creates a blocked contact.
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add skills/held-messages-list/ skills/held-messages-process/ src/skills/types.ts src/skills/execution.ts agents/coordinator.yaml
git commit -m "feat: add held-messages-list and held-messages-process skills"
```

---

### Task 6: Bootstrap Wiring

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/smoke/harness.ts`

- [ ] **Step 1: Wire HeldMessageService into bootstrap**

Read `src/index.ts`. After the contact system initialization, create HeldMessageService:

```typescript
  // Held messages — stores messages from unknown senders pending CEO review.
  const { HeldMessageService } = await import('./contacts/held-messages.js');
  const heldMessages = HeldMessageService.createWithPostgres(pool, logger);
  logger.info('Held message service initialized');
```

Actually, use a static import (per the feedback from Phase B1):

```typescript
import { HeldMessageService } from './contacts/held-messages.js';
```

Then in the initialization section:
```typescript
  const heldMessages = HeldMessageService.createWithPostgres(pool, logger);
  logger.info('Held message service initialized');
```

Pass to dispatcher:
```typescript
  const dispatcher = new Dispatcher({
    bus,
    logger,
    contactResolver,
    heldMessages,
    channelPolicies: authConfig?.channelPolicies,
  });
```

Note: `authConfig` needs to be available in the scope where the dispatcher is created. The auth config is loaded a few lines above — store it in a variable.

Pass to execution layer:
```typescript
  const executionLayer = new ExecutionLayer(skillRegistry, logger, {
    bus,
    agentRegistry,
    contactService,
    nylasClient,
    heldMessages,
  });
```

- [ ] **Step 2: Update smoke test harness**

Read `tests/smoke/harness.ts`. Pass `undefined` for new dispatcher/execution layer params.

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts tests/smoke/harness.ts
git commit -m "feat: wire HeldMessageService into bootstrap"
```

---

### Task 7: Update Spec and Document Open Questions

**Files:**
- Modify: `docs/specs/09-contacts-and-identity.md`

- [ ] **Step 1: Update the unknown sender policy section in spec 09**

Read `docs/specs/09-contacts-and-identity.md`. Find the "Unknown Sender Policy" section (around line 192). Update the email channel policy from `auto_reply` to `hold_and_notify`:

Change the table row for email from:
```
| **Email** | `low` | Auto-reply: "Received, forwarding to [CEO name]" |
```
To:
```
| **Email** | `low` | Hold silently, notify CEO |
```

Also add a note about the open question on held message expiration:

```markdown
> **Open question:** Held message expiration is deferred. Messages are currently held
> indefinitely until the CEO acts. A future discard/expiration process will need
> judgment and oversight — not a simple TTL timer. The CEO may want to batch-review
> old held messages, or have Nathan summarize and triage them.
```

- [ ] **Step 2: Commit**

```bash
git add docs/specs/09-contacts-and-identity.md
git commit -m "docs: update spec 09 — email uses hold_and_notify, document expiration open question"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Lint**

Run: `npx eslint src/ tests/`
Expected: Clean

- [ ] **Step 4: Commit plan**

```bash
git add docs/superpowers/plans/
git commit -m "docs: add unknown sender policy implementation plan"
```
