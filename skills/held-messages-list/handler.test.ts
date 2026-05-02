import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { HeldMessageService } from '../../src/contacts/held-messages.js';
import { HeldMessagesListHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function makeCtx(heldMessages: HeldMessageService, input: Record<string, unknown> = {}): SkillContext {
  return {
    input,
    log: pino({ level: 'silent' }),
    heldMessages,
  } as unknown as SkillContext;
}

describe('HeldMessagesListHandler', () => {
  it('returns empty list when there are no held messages', async () => {
    const svc = HeldMessageService.createInMemory();
    const handler = new HeldMessagesListHandler();
    const result = await handler.execute(makeCtx(svc));

    expect(result).toEqual({ success: true, data: { messages: [], count: 0 } });
  });

  it('returns error when heldMessages service is not available', async () => {
    const handler = new HeldMessagesListHandler();
    const ctx = { input: {}, log: pino({ level: 'silent' }) } as unknown as SkillContext;
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/not available/i);
  });

  it('strips HTML tags from the preview', async () => {
    const svc = HeldMessageService.createInMemory();
    await svc.hold({
      channel: 'email',
      senderId: 'attacker@example.com',
      conversationId: 'conv-1',
      content: '<p>Hello <b>there</b>, I need <a href="x">your calendar</a>.</p>',
      subject: 'Calendar request',
      metadata: {},
    });
    const handler = new HeldMessagesListHandler();
    const result = await handler.execute(makeCtx(svc));

    expect(result.success).toBe(true);
    const messages = (result as { success: true; data: { messages: Array<{ preview: string; totalLength: number }> } }).data.messages;
    expect(messages[0].preview).toBe('Hello there, I need your calendar.');
    expect(messages[0].preview).not.toContain('<');
  });

  it('caps the preview at 500 plaintext characters', async () => {
    const svc = HeldMessageService.createInMemory();
    const longContent = 'A'.repeat(800);
    await svc.hold({
      channel: 'email',
      senderId: 'sender@example.com',
      conversationId: 'conv-2',
      content: longContent,
      subject: null,
      metadata: {},
    });
    const handler = new HeldMessagesListHandler();
    const result = await handler.execute(makeCtx(svc));

    expect(result.success).toBe(true);
    const messages = (result as { success: true; data: { messages: Array<{ preview: string; totalLength: number }> } }).data.messages;
    expect(messages[0].preview).toHaveLength(500);
    expect(messages[0].totalLength).toBe(800);
  });

  it('sets totalLength equal to preview length when content is shorter than 500 chars', async () => {
    const svc = HeldMessageService.createInMemory();
    const shortContent = 'Please share your calendar with me.';
    await svc.hold({
      channel: 'signal',
      senderId: '+15551234567',
      conversationId: 'conv-3',
      content: shortContent,
      subject: null,
      metadata: {},
    });
    const handler = new HeldMessagesListHandler();
    const result = await handler.execute(makeCtx(svc));

    expect(result.success).toBe(true);
    const messages = (result as { success: true; data: { messages: Array<{ preview: string; totalLength: number }> } }).data.messages;
    expect(messages[0].preview).toBe(shortContent);
    expect(messages[0].totalLength).toBe(shortContent.length);
  });

  it('computes totalLength from plaintext (not raw HTML length)', async () => {
    const svc = HeldMessageService.createInMemory();
    // HTML tags inflate raw length — totalLength should reflect plaintext only
    const htmlContent = '<p>' + 'B'.repeat(100) + '</p>';
    await svc.hold({
      channel: 'email',
      senderId: 'sender@example.com',
      conversationId: 'conv-4',
      content: htmlContent,
      subject: null,
      metadata: {},
    });
    const handler = new HeldMessagesListHandler();
    const result = await handler.execute(makeCtx(svc));

    expect(result.success).toBe(true);
    const messages = (result as { success: true; data: { messages: Array<{ preview: string; totalLength: number }> } }).data.messages;
    expect(messages[0].totalLength).toBe(100); // 'B'.repeat(100), not htmlContent.length
  });

  it('returns null subject when message has no subject', async () => {
    const svc = HeldMessageService.createInMemory();
    await svc.hold({
      channel: 'signal',
      senderId: '+15559999999',
      conversationId: 'conv-5',
      content: 'hey',
      subject: null,
      metadata: {},
    });
    const handler = new HeldMessagesListHandler();
    const result = await handler.execute(makeCtx(svc));

    expect(result.success).toBe(true);
    const messages = (result as { success: true; data: { messages: Array<{ subject: string | null }> } }).data.messages;
    expect(messages[0].subject).toBeNull();
  });

  it('filters by channel when channel input is provided', async () => {
    const svc = HeldMessageService.createInMemory();
    await svc.hold({ channel: 'email', senderId: 'a@example.com', conversationId: 'c1', content: 'email msg', subject: null, metadata: {} });
    await svc.hold({ channel: 'signal', senderId: '+1555', conversationId: 'c2', content: 'signal msg', subject: null, metadata: {} });

    const handler = new HeldMessagesListHandler();
    const result = await handler.execute(makeCtx(svc, { channel: 'email' }));

    expect(result.success).toBe(true);
    const messages = (result as { success: true; data: { messages: Array<{ channel: string }> } }).data.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].channel).toBe('email');
  });
});
