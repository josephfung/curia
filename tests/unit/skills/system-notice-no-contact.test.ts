// A system notice must not turn its recipient into a contact (#2710, ADR-068).
//
// The operator is told, never talked with: no tier, no role, no approval rights. The outbound
// pipeline records every email recipient it writes to, so without a guard the first operator
// notice creates a *known*-tier contact — a tier that clears the unknown-sender hold, lets agents
// address them, and can be elevated later. These tests pin both paths: the direct send and the
// durable queue flush.
import { describe, it, expect, vi } from 'vitest';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import { OutboundQueueRepo } from '../../../src/skills/outbound-queue-repo.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { NylasClient } from '../../../src/channels/email/nylas-client.js';

const OPERATOR = 'operator@example.com';

function makeHarness() {
  const nylasClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
  } as unknown as NylasClient;
  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
    createContact: vi.fn().mockResolvedValue({ id: 'c1' }),
    linkIdentity: vi.fn().mockResolvedValue(undefined),
  } as unknown as ContactService;
  const bus = { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() } as unknown as EventBus;
  const gateway = new OutboundGateway({
    nylasClients: new Map([['curia', nylasClient]]),
    contactService,
    contentFilter: { check: vi.fn().mockResolvedValue({ passed: true, findings: [] }) } as unknown as OutboundContentFilter,
    bus,
    logger: createSilentLogger(),
  });
  return { gateway, contactService, nylasClient };
}

describe('a system notice sends without recording a contact', () => {
  it('does not create or promote the recipient of an isSystemNotification send', async () => {
    const { gateway, contactService } = makeHarness();

    const result = await gateway.send(
      { channel: 'email', to: OPERATOR, subject: 'Curia database unavailable', body: 'Curia cannot reach its Postgres database.' },
      { isSystemNotification: true, skipNotificationOnBlock: true },
    );

    expect(result.success).toBe(true);
    // The send path resolves identities for its own checks; what must not happen is a contact
    // being created (the promotion that would also write a KG person node and a confidence
    // signal). That is the invariant: no tier, no node, nothing to elevate.
    expect(contactService.createContact).not.toHaveBeenCalled();
  });

  it('still records an ordinary send’s recipient, so the guard is narrow', async () => {
    const { gateway, contactService } = makeHarness();

    await gateway.send({ channel: 'email', to: OPERATOR, subject: 'Hello', body: 'Ordinary mail.' });

    expect(contactService.createContact).toHaveBeenCalledOnce();
  });
});

describe('the queue carries the flag to the flush path', () => {
  function queuePool() {
    const inserted: Array<{ payload: string }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
        if (sql.includes('count(*)')) return { rows: [{ count: '0' }], rowCount: 1 };
        if (sql.includes('INSERT INTO outbound_queue')) {
          inserted.push({ payload: String(params![2]) });
          return { rows: [{ id: 'q1' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    return { pool: { connect: vi.fn(async () => client), query: vi.fn() }, inserted };
  }

  it('marks a queued system notice, and strips the marker before a channel sees it', async () => {
    const { pool, inserted } = queuePool();
    const repo = new OutboundQueueRepo(pool as never);

    await repo.enqueue(
      { channel: 'email', to: OPERATOR, subject: 's', body: 'b' },
      { systemNotification: true },
    );
    expect(JSON.parse(inserted[0]!.payload)).toMatchObject({ to: OPERATOR, __systemNotification: true });
  });

  it('reads the rows back without the marker, exposing the flag instead', async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('DELETE FROM outbound_queue')) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              id: 'q1',
              channel: 'email',
              recipient: OPERATOR,
              payload: { channel: 'email', to: OPERATOR, subject: 's', body: 'b', __systemNotification: true },
              enqueued_at: new Date(),
              expires_at: new Date(Date.now() + 60_000),
            },
          ],
          rowCount: 1,
        };
      }),
    };
    const repo = new OutboundQueueRepo(pool as never);

    const [row] = await repo.listPending('email');
    expect(row!.systemNotification).toBe(true);
    expect(row!.payload).not.toHaveProperty('__systemNotification');
  });

  it('leaves an ordinary queued send unflagged', async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('DELETE FROM outbound_queue')) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              id: 'q2',
              channel: 'email',
              recipient: OPERATOR,
              payload: { channel: 'email', to: OPERATOR, subject: 's', body: 'b' },
              enqueued_at: new Date(),
              expires_at: new Date(Date.now() + 60_000),
            },
          ],
          rowCount: 1,
        };
      }),
    };
    const [row] = await new OutboundQueueRepo(pool as never).listPending('email');
    expect(row!.systemNotification).toBe(false);
  });
});
