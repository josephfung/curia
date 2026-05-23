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
      expect(call[1]).toHaveLength(8);
      expect(call[1][0]).toBe('conv-1');
      expect(call[1][1]).toBe('signal');
      expect(call[1][2]).toBe('meeting-debrief');
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
      const preview = call[1][3] as string;
      expect(preview.length).toBeLessThanOrEqual(301);
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
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
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
