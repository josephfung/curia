import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import {
  OutboundQueueFullError,
  OutboundQueueRepo,
} from '../../../src/skills/outbound-queue-repo.js';
import { createLogger } from '../../../src/logger.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { SignalRpcClient } from '../../../src/channels/signal/signal-rpc-client.js';
import { createChannelReconnect } from '../../../src/bus/events.js';

function createMocks() {
  const logger = createLogger('error');
  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
  } as unknown as ContactService;
  const contentFilter = {
    check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
  } as unknown as OutboundContentFilter;
  const bus = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
  } as unknown as EventBus;
  return { logger, contactService, contentFilter, bus };
}

describe('OutboundQueueRepo (#1380)', () => {
  it('rejects enqueue when the per-channel cap is reached', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // advisory lock
        .mockResolvedValueOnce({ rowCount: 0 }) // deleteExpired
        .mockResolvedValueOnce({ rows: [{ count: '100' }] }) // count
        .mockResolvedValueOnce({}), // ROLLBACK
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn(),
    };
    const repo = new OutboundQueueRepo(pool as never, { maxPerChannel: 100 });
    await expect(
      repo.enqueue({ channel: 'signal', recipient: '+15555550100', message: 'hi' }),
    ).rejects.toBeInstanceOf(OutboundQueueFullError);
    expect(client.release).toHaveBeenCalled();
  });

  it('inserts a row when under the cap', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // lock
        .mockResolvedValueOnce({ rowCount: 0 }) // delete
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // count
        .mockResolvedValueOnce({ rows: [{ id: 'queue-1' }] }) // insert
        .mockResolvedValueOnce({}), // COMMIT
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn(),
    };
    const repo = new OutboundQueueRepo(pool as never, { maxPerChannel: 100, ttlHours: 24 });
    const result = await repo.enqueue({
      channel: 'signal',
      recipient: '+15555550100',
      message: 'queued',
    });
    expect(result).toEqual({ id: 'queue-1' });
    expect(client.release).toHaveBeenCalled();
  });
});

describe('OutboundGateway queue (#1380)', () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
  });

  it('queues a Signal send when the RPC client is disconnected', async () => {
    const signalClient = {
      send: vi.fn(),
      isConnected: vi.fn().mockReturnValue(false),
    };
    const outboundQueue = {
      enqueue: vi.fn().mockResolvedValue({ id: 'q-1' }),
      listPending: vi.fn(),
      deleteByIds: vi.fn(),
      deleteExpired: vi.fn(),
      countPending: vi.fn(),
    };

    const gateway = new OutboundGateway({
      signalClient: signalClient as unknown as SignalRpcClient,
      signalPhoneNumber: '+15555550000',
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      logger: mocks.logger,
      outboundQueue: outboundQueue as unknown as OutboundQueueRepo,
    });

    const result = await gateway.send({
      channel: 'signal',
      recipient: '+15555550100',
      message: 'hello while down',
    });

    expect(result.success).toBe(true);
    expect(result.queued).toBe(true);
    expect(result.messageId).toBe('q-1');
    expect(signalClient.send).not.toHaveBeenCalled();
    expect(outboundQueue.enqueue).toHaveBeenCalledOnce();
  });

  it('flushes queued Signal messages incrementally (delete after each success)', async () => {
    const signalClient = {
      send: vi.fn().mockResolvedValue('ts-1'),
      isConnected: vi.fn().mockReturnValue(true),
    };
    const rows = [
      {
        id: 'a',
        channel: 'signal',
        recipient: '+15555550100',
        payload: { channel: 'signal' as const, recipient: '+15555550100', message: 'one' },
        enqueuedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        id: 'b',
        channel: 'signal',
        recipient: '+15555550100',
        payload: { channel: 'signal' as const, recipient: '+15555550100', message: 'two' },
        enqueuedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    const outboundQueue = {
      enqueue: vi.fn(),
      listPending: vi.fn().mockResolvedValue(rows),
      deleteByIds: vi.fn().mockResolvedValue(1),
      deleteExpired: vi.fn(),
      countPending: vi.fn(),
    };

    const gateway = new OutboundGateway({
      signalClient: signalClient as unknown as SignalRpcClient,
      signalPhoneNumber: '+15555550000',
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      logger: mocks.logger,
      outboundQueue: outboundQueue as unknown as OutboundQueueRepo,
    });

    const flushed = await gateway.flushChannel('signal');
    expect(flushed).toEqual({ flushed: 2, skipped: false });
    expect(signalClient.send).toHaveBeenCalledTimes(2);
    expect(outboundQueue.deleteByIds).toHaveBeenNthCalledWith(1, ['a']);
    expect(outboundQueue.deleteByIds).toHaveBeenNthCalledWith(2, ['b']);
  });

  it('deletes successful rows then stops so they are not re-sent', async () => {
    const signalClient = {
      send: vi.fn()
        .mockResolvedValueOnce('ts-1')
        .mockRejectedValueOnce(new Error('still flaky')),
      isConnected: vi.fn().mockReturnValue(true),
    };
    const rows = [
      {
        id: 'a',
        channel: 'signal',
        recipient: '+15555550100',
        payload: { channel: 'signal' as const, recipient: '+15555550100', message: 'one' },
        enqueuedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        id: 'b',
        channel: 'signal',
        recipient: '+15555550100',
        payload: { channel: 'signal' as const, recipient: '+15555550100', message: 'two' },
        enqueuedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    const outboundQueue = {
      enqueue: vi.fn(),
      listPending: vi.fn().mockResolvedValue(rows),
      deleteByIds: vi.fn().mockResolvedValue(1),
      deleteExpired: vi.fn(),
      countPending: vi.fn(),
    };

    const gateway = new OutboundGateway({
      signalClient: signalClient as unknown as SignalRpcClient,
      signalPhoneNumber: '+15555550000',
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      logger: mocks.logger,
      outboundQueue: outboundQueue as unknown as OutboundQueueRepo,
    });

    const flushed = await gateway.flushChannel('signal');
    expect(flushed.flushed).toBe(1);
    expect(outboundQueue.deleteByIds).toHaveBeenCalledTimes(1);
    expect(outboundQueue.deleteByIds).toHaveBeenCalledWith(['a']);
  });

  it('start() flushes on channel.reconnect', async () => {
    const signalClient = {
      send: vi.fn().mockResolvedValue('ts-1'),
      isConnected: vi.fn().mockReturnValue(true),
    };
    const outboundQueue = {
      enqueue: vi.fn(),
      listPending: vi.fn().mockResolvedValue([]),
      deleteByIds: vi.fn(),
      deleteExpired: vi.fn(),
      countPending: vi.fn(),
    };
    const subscribers = new Map<string, (e: unknown) => void>();
    const bus = {
      publish: vi.fn(),
      subscribe: vi.fn((type: string, _layer: string, handler: (e: unknown) => void) => {
        subscribers.set(type, handler);
      }),
    } as unknown as EventBus;

    const gateway = new OutboundGateway({
      signalClient: signalClient as unknown as SignalRpcClient,
      signalPhoneNumber: '+15555550000',
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus,
      logger: mocks.logger,
      outboundQueue: outboundQueue as unknown as OutboundQueueRepo,
    });
    gateway.start();

    const handler = subscribers.get('channel.reconnect');
    expect(handler).toBeTypeOf('function');
    handler!(createChannelReconnect({ channel: 'signal' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(outboundQueue.listPending).toHaveBeenCalledWith('signal');
  });
});
