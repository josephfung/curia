// tests/unit/dispatch/dispatcher-context-bridging.test.ts
//
// Tests the v2 context bridging flow: OutboundContextService-backed injection
// into coordinator tasks on inbound messages — including the liveTurn audience
// gate (#1848 / #1598).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundContextService } from '../../../src/dispatch/outbound-context.js';
import type { OutboundContextRow } from '../../../src/dispatch/outbound-context.js';
import type { DbPool } from '../../../src/db/connection.js';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createInboundMessage, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import type { ContactTier } from '../../../src/contacts/types.js';
import { createLogger } from '../../../src/logger.js';
import * as stampOriginatorMod from '../../../src/dispatch/stamp-originator.js';
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
    expect(result).toContain('entry_id (for context-bridge-release only — NOT a Nylas/email message id): entry-1');
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

    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).toContain('released = false');
    expect(sql).toContain('expires_at > now()');
  });
});

describe('Dispatcher outbound-context liveTurn gate (#1848)', () => {
  const activeEntry = makeActiveEntry({
    id: 'entry-signal-alert',
    contentPreview: 'Evan Neurology — T-2 check for Thursday',
    metadata: { task_id: '3804c301-aaaa-bbbb-cccc-dddddddddddd', bind_reply: true },
  });

  function makeResolver(opts: {
    resolved?: boolean;
    systemRole?: 'principal' | 'agent' | 'system' | null;
    tier?: ContactTier;
  } = {}): ContactResolver {
    if (opts.resolved === false) {
      return {
        resolve: async (channel: string, senderId: string) => ({
          resolved: false,
          channel,
          senderId,
        }),
      } as unknown as ContactResolver;
    }
    return {
      resolve: async () => ({
        resolved: true,
        contactId: opts.systemRole === 'principal' ? 'principal-1' : 'contact-other-1',
        displayName: opts.systemRole === 'principal' ? 'Principal' : 'Other Contact',
        role: null,
        systemRole: opts.systemRole ?? null,
        tier: opts.tier ?? (opts.systemRole === 'principal' ? 'principal' : 'known'),
        kind: 'person',
        verified: true,
        kgNodeId: null,
        knowledgeSummary: '',
        authorization: null,
        contactConfidence: 0.9,
      }),
    } as unknown as ContactResolver;
  }

  function buildHarness(resolver: ContactResolver) {
    const busLogger = createLogger('error');
    const bus = new EventBus(busLogger);
    const tasks: AgentTaskEvent[] = [];
    const getActive = vi.fn(async () => [activeEntry]);
    const formatInjectionBlock = vi.fn(
      (entries: OutboundContextRow[], originalContent: string) => {
        if (entries.length === 0) return null;
        return [
          '[ACTIVE OUTBOUND CONTEXT — messages you\'ve sent that may receive replies]',
          `entry_id (for context-bridge-release only — NOT a Nylas/email message id): ${entries[0]!.id}`,
          `preview: "${entries[0]!.contentPreview}"`,
          '',
          originalContent,
        ].join('\n');
      },
    );
    const outboundContextService = {
      getActive,
      formatInjectionBlock,
    } as unknown as OutboundContextService;

    const dispatcher = new Dispatcher({
      bus,
      logger: busLogger,
      contactResolver: resolver,
      outboundContextService,
    });
    dispatcher.register();

    bus.subscribe('agent.task', 'agent', (e) => {
      tasks.push(e as AgentTaskEvent);
    });

    return { bus, tasks, getActive, formatInjectionBlock };
  }

  it('injects ACTIVE OUTBOUND CONTEXT for principal inbound (liveTurn=true)', async () => {
    const { bus, tasks, getActive } = buildHarness(
      makeResolver({ systemRole: 'principal', tier: 'principal' }),
    );

    await bus.publish(
      'channel',
      createInboundMessage({
        conversationId: 'email:thread-principal',
        channelId: 'email',
        senderId: 'ceo@example.com',
        content: 'Any update on the neurology appointment?',
      }),
    );

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.payload.liveTurn).toBe(true);
    expect(getActive).toHaveBeenCalledOnce();
    expect(tasks[0]!.payload.content).toContain('[ACTIVE OUTBOUND CONTEXT');
    expect(tasks[0]!.payload.content).toContain('entry-signal-alert');
    expect(tasks[0]!.payload.content).toContain('Evan Neurology — T-2 check for Thursday');
    expect(tasks[0]!.payload.content).toContain('Any update on the neurology appointment?');
  });

  it.each([
    { channelId: 'signal' as const, conversationId: 'signal:+15551234567', senderId: '+15551234567' },
    { channelId: 'slack' as const, conversationId: 'slack:U123', senderId: 'U123' },
    { channelId: 'sms' as const, conversationId: 'sms:+15559876543', senderId: '+15559876543' },
    { channelId: 'cli' as const, conversationId: 'cli:local', senderId: 'local-user' },
    { channelId: 'web' as const, conversationId: 'web:ceo', senderId: 'ceo-web-user' },
  ])('injects for principal inbound on $channelId (gate is channel-agnostic)', async ({ channelId, conversationId, senderId }) => {
    // Rows pin that the dispatcher applies one liveTurn gate across channels —
    // not per-channel carve-outs. Resolver shortcuts for cli/web are covered in
    // contact-resolver.test.ts (systemRole assertions against the real resolver).
    const { bus, tasks, getActive } = buildHarness(
      makeResolver({ systemRole: 'principal', tier: 'principal' }),
    );

    await bus.publish(
      'channel',
      createInboundMessage({
        conversationId,
        channelId,
        senderId,
        content: 'Following up',
      }),
    );

    expect(getActive).toHaveBeenCalledOnce();
    expect(tasks[0]!.payload.content).toContain('[ACTIVE OUTBOUND CONTEXT');
  });

  it('does not inject for a resolved non-principal contact (liveTurn=false)', async () => {
    const { bus, tasks, getActive } = buildHarness(
      makeResolver({ systemRole: null, tier: 'known' }),
    );

    await bus.publish(
      'channel',
      createInboundMessage({
        conversationId: 'email:thread-third-party',
        channelId: 'email',
        senderId: 'external@example.com',
        content: 'Can we meet Thursday?',
      }),
    );

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.payload.liveTurn).toBe(false);
    expect(getActive).not.toHaveBeenCalled();
    expect(tasks[0]!.payload.content).not.toContain('[ACTIVE OUTBOUND CONTEXT');
    expect(tasks[0]!.payload.content).not.toContain('Evan Neurology');
    expect(tasks[0]!.payload.content).toBe('Can we meet Thursday?');
  });

  it('does not inject for an unresolved sender (tier unknown, liveTurn=false)', async () => {
    const { bus, tasks, getActive } = buildHarness(makeResolver({ resolved: false }));

    await bus.publish(
      'channel',
      createInboundMessage({
        conversationId: 'email:thread-unknown',
        channelId: 'email',
        senderId: 'stranger@example.com',
        content: 'Hello from nowhere',
      }),
    );

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.payload.liveTurn).toBe(false);
    expect(tasks[0]!.payload.metadata?.originator).toMatchObject({ tier: 'unknown' });
    expect(getActive).not.toHaveBeenCalled();
    expect(tasks[0]!.payload.content).not.toContain('[ACTIVE OUTBOUND CONTEXT');
    expect(tasks[0]!.payload.content).toBe('Hello from nowhere');
  });

  it('calls stampOriginator exactly once per inbound', async () => {
    const spy = vi.spyOn(stampOriginatorMod, 'stampOriginator');
    try {
      const { bus } = buildHarness(
        makeResolver({ systemRole: 'principal', tier: 'principal' }),
      );

      await bus.publish(
        'channel',
        createInboundMessage({
          conversationId: 'email:thread-once',
          channelId: 'email',
          senderId: 'ceo@example.com',
          content: 'Check once',
        }),
      );

      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});
