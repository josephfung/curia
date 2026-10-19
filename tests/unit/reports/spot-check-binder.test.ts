import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpotCheckBinder } from '../../../src/reports/spot-check-binder.js';
import { SPOT_CHECK_HEADER } from '../../../src/reports/spot-check-sampler.js';
import { createOutboundDelivered } from '../../../src/bus/events.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { ChannelIdentity } from '../../../src/contacts/types.js';
import { createSilentLogger, type Logger } from '../../../src/logger.js';
import type { SpotCheckSet, SpotCheckStore } from '../../../src/reports/spot-check-store.js';
import type { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import type { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';

function makePrincipal(channel: string, identifier: string): ChannelIdentity {
  return {
    id: `id-${channel}`,
    contactId: 'principal-1',
    channel,
    channelIdentifier: identifier,
    label: null,
    verified: true,
    verifiedAt: new Date(),
    status: 'active',
    source: channel === 'email' ? 'email_participant' : 'signal_participant',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// The binder only binds messages that carry the block, so the default body includes the header.
const DIGEST = `Today's recap\n\n${SPOT_CHECK_HEADER}\n1. Accepted the Q3 sync invite`;

const BOUND_SET: SpotCheckSet = {
  id: 'set-1',
  createdAt: '2026-10-19T11:55:00.000Z',
  conversationId: 'scheduler:job1:run1',
  items: [{ n: 1, actionLogId: 101, summary: 'Accepted the Q3 sync invite' }],
  deliveries: [],
};

describe('SpotCheckBinder', () => {
  let bus: { subscribe: ReturnType<typeof vi.fn>; publish: ReturnType<typeof vi.fn> };
  let store: { bindDelivery: ReturnType<typeof vi.fn> };
  let actionLogRepo: { markSampled: ReturnType<typeof vi.fn> };
  let gateway: { getEmailMessage: ReturnType<typeof vi.fn> };
  let logger: ReturnType<typeof createSilentLogger>;
  let warn: ReturnType<typeof vi.fn>;
  let error: ReturnType<typeof vi.fn>;
  let info: ReturnType<typeof vi.fn>;
  let handler: (event: unknown) => Promise<void>;

  beforeEach(() => {
    bus = { subscribe: vi.fn(), publish: vi.fn() };
    store = { bindDelivery: vi.fn().mockResolvedValue({ kind: 'bound', set: BOUND_SET }) };
    gateway = { getEmailMessage: vi.fn().mockResolvedValue({ threadId: 'th1' }) };
    actionLogRepo = { markSampled: vi.fn().mockResolvedValue(1) };
    logger = createSilentLogger();
    // Spy on the child logger the binder builds, so warnings/errors can be asserted.
    warn = vi.fn();
    error = vi.fn();
    info = vi.fn();
    const child = { info, debug: vi.fn(), warn, error } as unknown as Logger;
    vi.spyOn(logger, 'child').mockReturnValue(child as never);

    new SpotCheckBinder({
      bus: bus as unknown as EventBus,
      store: store as unknown as Pick<SpotCheckStore, 'bindDelivery'>,
      gateway: gateway as unknown as Pick<OutboundGateway, 'getEmailMessage'>,
      actionLogRepo: actionLogRepo as unknown as Pick<ActionLogRepo, 'markSampled'>,
      principalIdentities: [
        makePrincipal('email', 'dana@example.com'),
        makePrincipal('signal', '+15555550100'),
      ],
      logger,
    }).register();
    handler = bus.subscribe.mock.calls[0]![2] as (event: unknown) => Promise<void>;
  });

  it('subscribes to outbound.delivered on the dispatch layer', () => {
    expect(bus.subscribe).toHaveBeenCalledWith('outbound.delivered', 'dispatch', expect.any(Function));
  });

  it('binds an email delivery to the principal with the message thread id', async () => {
    await handler(createOutboundDelivered({
      channel: 'email',
      recipientId: 'dana@example.com',
      content: DIGEST,
      conversationId: 'scheduler:job1:run1',
      messageId: 'm1',
    }));

    expect(gateway.getEmailMessage).toHaveBeenCalledWith('m1');
    expect(store.bindDelivery).toHaveBeenCalledWith('scheduler:job1:run1', {
      channel: 'email',
      messageId: 'm1',
      threadId: 'th1',
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    }, DIGEST);
    // One info line per bind, so a bound digest is visible in the logs.
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ setId: 'set-1', channel: 'email', messageId: 'm1', threadId: true }),
      expect.any(String),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('binds a Signal delivery without a thread id and without fetching an email', async () => {
    await handler(createOutboundDelivered({
      channel: 'signal',
      recipientId: '+15555550100',
      content: DIGEST,
      conversationId: 'scheduler:job1:run1',
      messageId: '1710000000000',
    }));

    expect(gateway.getEmailMessage).not.toHaveBeenCalled();
    const delivery = store.bindDelivery.mock.calls[0]![1] as Record<string, unknown>;
    expect(delivery['channel']).toBe('signal');
    expect(delivery['messageId']).toBe('1710000000000');
    expect('threadId' in delivery).toBe(false);
  });

  it('does not bind, or warn, when the recipient is not the principal', async () => {
    await handler(createOutboundDelivered({
      channel: 'email', content: DIGEST, recipientId: 'sam@example.com', conversationId: 'c1', messageId: 'm1',
    }));

    expect(store.bindDelivery).not.toHaveBeenCalled();
    expect(gateway.getEmailMessage).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  // A queue-flushed send has no conversationId. The digest went out with numbers nobody can
  // resolve, so that must be loud, not a silent skip.
  it.each([
    ['there is no conversationId', { recipientId: 'dana@example.com', messageId: 'm1' }],
    ['there is no messageId', { recipientId: 'dana@example.com', conversationId: 'c1' }],
  ])('warns and does not bind a spot-check digest when %s', async (_label, fields) => {
    await handler(createOutboundDelivered({
      channel: 'email',
      content: DIGEST,
      ...fields,
    }));

    expect(store.bindDelivery).not.toHaveBeenCalled();
    expect(gateway.getEmailMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email' }),
      'spot-check digest delivered without conversationId/messageId; its numbers cannot be answered',
    );
  });

  it('stays quiet about a message without the block and without ids', async () => {
    await handler(createOutboundDelivered({ channel: 'email', recipientId: 'dana@example.com', content: 'hello' }));

    expect(store.bindDelivery).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['no_set', 'rejected'] as const)('warns when the store reports %s for a principal digest', async (kind) => {
    store.bindDelivery.mockResolvedValue({ kind });

    await handler(createOutboundDelivered({
      channel: 'signal',
      recipientId: '+15555550100',
      content: DIGEST,
      conversationId: 'scheduler:job1:run1',
      messageId: '1710000000000',
    }));

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'scheduler:job1:run1', messageId: '1710000000000', kind }),
      expect.any(String),
    );
    expect(info).not.toHaveBeenCalledWith(expect.objectContaining({ setId: expect.anything() }), expect.any(String));
    // Unbound rows stay in the pool and can be offered again.
    expect(actionLogRepo.markSampled).not.toHaveBeenCalled();
  });

  // Rows leave the pool only once their digest reached the principal and can be answered.
  it('marks the bound set\'s rows sampled', async () => {
    await handler(createOutboundDelivered({
      channel: 'signal',
      recipientId: '+15555550100',
      content: DIGEST,
      conversationId: 'scheduler:job1:run1',
      messageId: '1710000000000',
    }));

    expect(actionLogRepo.markSampled).toHaveBeenCalledWith([101], expect.any(Date));
  });

  it('does not mark anything for a digest it did not bind', async () => {
    await handler(createOutboundDelivered({
      channel: 'email', content: DIGEST, recipientId: 'sam@example.com', conversationId: 'c1', messageId: 'm1',
    }));
    await handler(createOutboundDelivered({ channel: 'email', content: DIGEST, recipientId: 'dana@example.com' }));

    expect(actionLogRepo.markSampled).not.toHaveBeenCalled();
  });

  it('logs at error, and does not throw, when marking the rows fails', async () => {
    actionLogRepo.markSampled.mockRejectedValue(new Error('db down'));

    await expect(handler(createOutboundDelivered({
      channel: 'signal',
      recipientId: '+15555550100',
      content: DIGEST,
      conversationId: 'scheduler:job1:run1',
      messageId: '1710000000000',
    }))).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ setId: 'set-1', actionLogIds: [101] }),
      expect.any(String),
    );
  });

  it('does not bind a delivery that lost the spot-check block', async () => {
    await handler(createOutboundDelivered({
      channel: 'email',
      recipientId: 'dana@example.com',
      content: "Today's recap, nothing else",
      conversationId: 'scheduler:job1:run1',
      messageId: 'm1',
    }));

    expect(store.bindDelivery).not.toHaveBeenCalled();
    expect(gateway.getEmailMessage).not.toHaveBeenCalled();
  });

  it('still binds, without a thread id, and warns when the email lookup throws', async () => {
    gateway.getEmailMessage.mockRejectedValue(new Error('nylas down'));

    await handler(createOutboundDelivered({
      channel: 'email',
      recipientId: 'dana@example.com',
      content: DIGEST,
      conversationId: 'scheduler:job1:run1',
      messageId: 'm1',
    }));

    expect(warn).toHaveBeenCalled();
    const delivery = store.bindDelivery.mock.calls[0]![1] as Record<string, unknown>;
    expect(delivery['messageId']).toBe('m1');
    expect('threadId' in delivery).toBe(false);
  });

  it('logs and does not throw when bindDelivery throws', async () => {
    store.bindDelivery.mockRejectedValue(new Error('db down'));

    await expect(handler(createOutboundDelivered({
      channel: 'email',
      recipientId: 'dana@example.com',
      content: DIGEST,
      conversationId: 'scheduler:job1:run1',
      messageId: 'm1',
    }))).resolves.toBeUndefined();

    expect(error).toHaveBeenCalled();
  });
});
