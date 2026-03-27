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
    const limited = HeldMessageService.createInMemory(3);

    await limited.hold({ channel: 'email', senderId: 'a@example.com', conversationId: 'e:1', content: '1', subject: null, metadata: {} });
    await limited.hold({ channel: 'email', senderId: 'b@example.com', conversationId: 'e:2', content: '2', subject: null, metadata: {} });
    await limited.hold({ channel: 'email', senderId: 'c@example.com', conversationId: 'e:3', content: '3', subject: null, metadata: {} });
    await limited.hold({ channel: 'email', senderId: 'd@example.com', conversationId: 'e:4', content: '4', subject: null, metadata: {} });

    const pending = await limited.listPending('email');
    expect(pending).toHaveLength(3);
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
