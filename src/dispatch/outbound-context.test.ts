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
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
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

      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const preview = call[1][3] as string;
      expect(preview.length).toBeLessThanOrEqual(301);
      expect(preview.endsWith('…')).toBe(true);
    });

    it('defaults expiresInHours to the configured defaultExpiryHours when entry omits expiresInHours', async () => {
      const customService = new OutboundContextService(pool, logger, { defaultExpiryHours: 8 });
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: 'some-id' }],
      });

      await customService.register({
        conversationId: 'conv-1',
        channelId: 'signal',
        agentId: 'coordinator',
        content: 'Short message',
      });

      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const expiresAt = call[1][7] as Date;
      const expectedMs = Date.now() + 8 * 60 * 60 * 1000;
      expect(Math.abs(expiresAt.getTime() - expectedMs)).toBeLessThan(5000);
    });

    it('falls back to 6 hours when no config is provided and entry omits expiresInHours', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: 'some-id' }],
      });

      await service.register({
        conversationId: 'conv-1',
        channelId: 'signal',
        agentId: 'coordinator',
        content: 'Short message',
      });

      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const expiresAt = call[1][7] as Date;
      const expectedMs = Date.now() + 6 * 60 * 60 * 1000;
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
      expect(result[0]!.id).toBe('id-1');
      expect(result[0]!.conversationId).toBe('conv-1');
      expect(result[0]!.agentId).toBe('meeting-debrief');
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('released = false');
      expect(call[0]).toContain('expires_at > now()');
      // Unscoped path — no conversation predicate.
      expect(call[0]).not.toContain('conversation_id = $1');
      expect(call[0]).not.toContain('bind_reply');
    });

    it('respects the limit parameter', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
      await service.getActive({ limit: 5 });
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[1][0]).toBe(5);
    });

    it('defaults limit to 10', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
      await service.getActive();
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[1][0]).toBe(10);
    });

    it('scopes to conversationId and includes bind_reply cross-conversation entries (#1817)', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
      await service.getActive({ conversationId: 'email:thread-a', limit: 7 });

      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const sql = call[0] as string;
      expect(sql).toContain('conversation_id = $1');
      expect(sql).toContain(`metadata @> '{"bind_reply": true}'::jsonb`);
      expect(sql).toContain('released = false');
      expect(sql).toContain('expires_at > now()');
      expect(call[1]).toEqual(['email:thread-a', 7]);
    });

    it('defaults scoped limit to 10 when conversationId is set without limit', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
      await service.getActive({ conversationId: 'signal:ceo' });
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[1]).toEqual(['signal:ceo', 10]);
    });
  });

  describe('release', () => {
    it('sets released = true for the given entry ID', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: 1 });
      await service.release('entry-id-1');
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('UPDATE outbound_context');
      expect(call[0]).toContain('released = true');
      expect(call[1][0]).toBe('entry-id-1');
    });

    it('scopes release to conversation when conversationId provided', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: 1 });
      await service.release('entry-id-1', 'conv-42');
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('conversation_id = $2');
      expect(call[1][0]).toBe('entry-id-1');
      expect(call[1][1]).toBe('conv-42');
    });
  });

  describe('cleanupExpired', () => {
    it('deletes rows where released = true OR expires_at has passed', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: 3 });
      const count = await service.cleanupExpired();
      expect(count).toBe(3);
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('DELETE FROM outbound_context');
    });
  });

  describe('clearBySubjects', () => {
    it('releases all active entries matching each subject (case-insensitive) and returns per-subject counts', async () => {
      // Subject "Sean Brownlee" → 4 rows; "Khanjan Desai" → 2 rows.
      (pool.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ rowCount: 4, rows: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }] })
        .mockResolvedValueOnce({ rowCount: 2, rows: [{ id: '5' }, { id: '6' }] });

      const result = await service.clearBySubjects(['Sean Brownlee', 'khanjan desai']);

      expect(result.totalReleased).toBe(6);
      expect(result.perSubject).toEqual([
        { subject: 'Sean Brownlee', released: 4 },
        { subject: 'khanjan desai', released: 2 },
      ]);
      expect(result.unmatched).toEqual([]);

      // First statement: releases by case-insensitive metadata subject, active rows only.
      const first = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(first[0]).toContain('UPDATE outbound_context');
      expect(first[0]).toContain('released = false');
      expect(first[0]).toContain("expires_at > now()");
      expect(first[0]).toContain("lower(metadata->>'subject') = lower($1)");
      expect(first[0]).toContain('RETURNING id');
      expect(first[1]).toEqual(['Sean Brownlee']);
    });

    it('reports subjects that matched zero active entries as unmatched', async () => {
      (pool.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ rowCount: 3, rows: [{ id: '1' }, { id: '2' }, { id: '3' }] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await service.clearBySubjects(['Walk and Ice cream', 'Nonexistent Meeting']);

      expect(result.totalReleased).toBe(3);
      expect(result.perSubject).toEqual([{ subject: 'Walk and Ice cream', released: 3 }]);
      expect(result.unmatched).toEqual(['Nonexistent Meeting']);
    });

    it('trims, drops blank subjects, and de-duplicates case-insensitively before querying', async () => {
      (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: 1, rows: [{ id: '1' }] });

      const result = await service.clearBySubjects(['  Peter Lenardon  ', '', '   ', 'peter lenardon']);

      // Only one query runs — blanks dropped, the duplicate (case-insensitive) collapsed.
      expect((pool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[1]).toEqual(['Peter Lenardon']); // trimmed, first-seen casing preserved
      expect(result.totalReleased).toBe(1);
    });

    it('returns an empty result without querying when given no usable subjects', async () => {
      const result = await service.clearBySubjects(['', '   ']);

      expect((pool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
      expect(result).toEqual({ totalReleased: 0, perSubject: [], unmatched: [] });
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
      expect(result).toContain('outbound_context_entry_id (for context-bridge-release only — NOT a Nylas/email message id): abc-123');
      expect(result).toContain('Do not pass them as email-reply reply_to_message_id');
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

describe('OutboundContextService TTL config', () => {
  it('exposes defaultExpiryHours = 6 when no config provided', () => {
    const pool = makePool();
    const service = new OutboundContextService(pool, logger);
    expect(service.defaultExpiryHours).toBe(6);
  });

  it('exposes explicitExpiryHours = 24 when no config provided', () => {
    const pool = makePool();
    const service = new OutboundContextService(pool, logger);
    expect(service.explicitExpiryHours).toBe(24);
  });

  it('respects configured defaultExpiryHours', () => {
    const pool = makePool();
    const service = new OutboundContextService(pool, logger, { defaultExpiryHours: 12 });
    expect(service.defaultExpiryHours).toBe(12);
  });

  it('respects configured explicitExpiryHours', () => {
    const pool = makePool();
    const service = new OutboundContextService(pool, logger, { explicitExpiryHours: 48 });
    expect(service.explicitExpiryHours).toBe(48);
  });
});

// Channel-aware TTL defaults (#1816). Email replies arrive on business-day
// rhythms, so a flat 6h window expired before any realistic correspondent
// could answer. Synchronous chat channels keep the short window.
describe('OutboundContextService channel-aware TTL defaults', () => {
  it('defaults email to 72 hours so a next-business-day reply still lands in context', () => {
    const service = new OutboundContextService(makePool(), logger);
    expect(service.defaultExpiryHoursFor('email')).toBe(72);
  });

  it('keeps synchronous channels on the short default — no blanket widening', () => {
    const service = new OutboundContextService(makePool(), logger);
    expect(service.defaultExpiryHoursFor('signal')).toBe(6);
    expect(service.defaultExpiryHoursFor('slack')).toBe(6);
    expect(service.defaultExpiryHoursFor('sms')).toBe(6);
  });

  it('falls back to defaultExpiryHours for channels with no built-in entry', () => {
    const service = new OutboundContextService(makePool(), logger, { defaultExpiryHours: 9 });
    expect(service.defaultExpiryHoursFor('voice')).toBe(9);
    // Raising the global default must not drag email down to it.
    expect(service.defaultExpiryHoursFor('email')).toBe(72);
  });

  it('lets YAML override any channel default', () => {
    const service = new OutboundContextService(makePool(), logger, {
      channelDefaultExpiryHours: { email: 96, signal: 12 },
    });
    expect(service.defaultExpiryHoursFor('email')).toBe(96);
    expect(service.defaultExpiryHoursFor('signal')).toBe(12);
    // Channels absent from the override keep their resolved value.
    expect(service.defaultExpiryHoursFor('slack')).toBe(6);
  });

  it('registers an email with the 72h channel default when the entry omits expiresInHours', async () => {
    const pool = makePool();
    const service = new OutboundContextService(pool, logger);
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ id: 'e1' }] });

    await service.register({
      conversationId: 'conv-1',
      channelId: 'email',
      agentId: 'coordinator',
      content: 'Could you complete the registration form?',
    });

    const expiresAt = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1][7] as Date;
    expect(Math.abs(expiresAt.getTime() - (Date.now() + 72 * 3_600_000))).toBeLessThan(5000);
  });

  it('registers a signal message with the 6h channel default when the entry omits expiresInHours', async () => {
    const pool = makePool();
    const service = new OutboundContextService(pool, logger);
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ id: 's1' }] });

    await service.register({
      conversationId: 'conv-1',
      channelId: 'signal',
      agentId: 'coordinator',
      content: 'Heads up — the 3pm moved.',
    });

    const expiresAt = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1][7] as Date;
    expect(Math.abs(expiresAt.getTime() - (Date.now() + 6 * 3_600_000))).toBeLessThan(5000);
  });

  it('honours an explicit expiresInHours over the channel default', async () => {
    const pool = makePool();
    const service = new OutboundContextService(pool, logger);
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ id: 'e2' }] });

    await service.register({
      conversationId: 'conv-1',
      channelId: 'email',
      agentId: 'coordinator',
      content: 'Quick one.',
      expiresInHours: 2,
    });

    const expiresAt = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1][7] as Date;
    expect(Math.abs(expiresAt.getTime() - (Date.now() + 2 * 3_600_000))).toBeLessThan(5000);
  });

  it('logs the resolved TTL and its source at registration', async () => {
    const pool = makePool();
    const spyLogger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const service = new OutboundContextService(
      pool,
      spyLogger as unknown as typeof logger,
    );
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ id: 'e3' }] });

    await service.register({
      conversationId: 'conv-1',
      channelId: 'email',
      agentId: 'coordinator',
      content: 'Please confirm.',
    });

    expect(spyLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'email',
        expiresInHours: 72,
        ttlSource: 'channel-default',
      }),
      'Outbound context entry registered',
    );
  });

  it('trusts the caller-declared ttlSource over deriving one', async () => {
    const pool = makePool();
    const spyLogger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const service = new OutboundContextService(pool, spyLogger as unknown as typeof logger);
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ id: 'e4' }] });

    // The production caller resolves the channel default itself and passes it,
    // so deriving 'agent' from "expiresInHours is set" would credit the agent
    // for a window the system chose.
    await service.register({
      conversationId: 'conv-1',
      channelId: 'email',
      agentId: 'coordinator',
      content: 'Please confirm.',
      expiresInHours: 72,
      ttlSource: 'channel-default',
    });

    expect(spyLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInHours: 72, ttlSource: 'channel-default' }),
      'Outbound context entry registered',
    );
  });

  it('derives ttlSource as agent when a TTL is supplied with no declared source', async () => {
    const pool = makePool();
    const spyLogger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const service = new OutboundContextService(pool, spyLogger as unknown as typeof logger);
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ id: 'e5' }] });

    await service.register({
      conversationId: 'conv-1',
      channelId: 'email',
      agentId: 'coordinator',
      content: 'Please confirm.',
      expiresInHours: 168,
    });

    expect(spyLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInHours: 168, ttlSource: 'agent' }),
      'Outbound context entry registered',
    );
  });

  it('logs the resolved TTL policy once at construction, at info', () => {
    const spyLogger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    new OutboundContextService(makePool(), spyLogger as unknown as typeof logger, {
      channelDefaultExpiryHours: { emial: 96 },
    });

    expect(spyLogger.info).toHaveBeenCalledWith(
      {
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
        // The typo'd key sits next to the still-72 real one — which is how an
        // operator finds out their override did nothing.
        channelDefaults: { email: 72, emial: 96 },
      },
      'Outbound context TTL policy resolved',
    );
  });
});

describe('ScopedOutboundContext TTL delegation', () => {
  it('exposes defaultExpiryHours from the underlying service', () => {
    const pool = makePool();
    const service = new OutboundContextService(pool, logger, { defaultExpiryHours: 10 });
    const scoped = new ScopedOutboundContext(service, 'conv-1');
    expect(scoped.defaultExpiryHours).toBe(10);
  });

  it('exposes explicitExpiryHours from the underlying service', () => {
    const pool = makePool();
    const service = new OutboundContextService(pool, logger, { explicitExpiryHours: 36 });
    const scoped = new ScopedOutboundContext(service, 'conv-1');
    expect(scoped.explicitExpiryHours).toBe(36);
  });

  it('delegates defaultExpiryHoursFor to the underlying service', () => {
    const pool = makePool();
    const service = new OutboundContextService(pool, logger, {
      channelDefaultExpiryHours: { email: 84 },
    });
    const scoped = new ScopedOutboundContext(service, 'conv-1');
    expect(scoped.defaultExpiryHoursFor('email')).toBe(84);
    expect(scoped.defaultExpiryHoursFor('signal')).toBe(6);
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

  it('delegates release() with conversationId to the service', async () => {
    const pool = makePool();
    const service = new OutboundContextService(pool, logger);
    const releaseSpy = vi.spyOn(service, 'release').mockResolvedValue(undefined);

    const scoped = new ScopedOutboundContext(service, 'conv-42');
    await scoped.release('entry-1');

    expect(releaseSpy).toHaveBeenCalledWith('entry-1', 'conv-42');
  });
});
