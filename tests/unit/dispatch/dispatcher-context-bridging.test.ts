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
import * as stampOriginatorMod from '../../../src/contacts/stamp-originator.js';
import { TURN_GUIDANCE_HEADER } from '../../../src/agents/prompts/turn-guidance.js';
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
    recipientContactIds: null,
    recipientMessages: [],
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
    expect(result).toContain('entry_id (for delegate\'s outbound_entry_id or context-bridge-release — NOT a Nylas/email message id): entry-1');
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
    verified?: boolean;
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
        verified: opts.verified ?? true,
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
          `entry_id (for delegate\'s outbound_entry_id or context-bridge-release — NOT a Nylas/email message id): ${entries[0]!.id}`,
          `preview: "${entries[0]!.contentPreview}"`,
          '',
          originalContent,
        ].join('\n');
      },
    );
    // A non-principal sender's own entries (#2261): none unless a test supplies them.
    const getActiveForRecipient = vi.fn(async (_contactId: string): Promise<OutboundContextRow[]> => []);
    const recordReply = vi.fn(async () => undefined);
    const outboundContextService = {
      getActive,
      getActiveForRecipient,
      recordReply,
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

    return { bus, tasks, getActive, getActiveForRecipient, recordReply, formatInjectionBlock };
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
    expect(tasks[0]!.payload.content).toBe('Account: curia\n\nCan we meet Thursday?');
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
    expect(tasks[0]!.payload.content).toBe('Account: curia\n\nHello from nowhere');
  });

  describe('recipient-matched block for a non-principal sender (#2261)', () => {
    const lunchAsk = makeActiveEntry({
      id: 'efc521b3-4ef1-40ca-a34f-63f18629fe21',
      agentId: 'coordinator',
      contentPreview: 'Any of these work for you: Tue Oct 27, Thu Nov 5?',
      expectedReply: 'which candidate lunch dates Xiaopu can join',
      delegationHint: null,
      metadata: null,
      recipientContactIds: ['contact-other-1'],
      recipientMessages: [],
    });

    // A one-to-one Signal message, as the adapter publishes it (isGroup: false).
    async function sendFromContact(
      harness: ReturnType<typeof buildHarness>,
      content = 'Thur Nov 5',
      metadata: Record<string, unknown> = {},
    ) {
      await harness.bus.publish('channel', createInboundMessage({
        conversationId: 'signal:+15195040098',
        channelId: 'signal',
        senderId: '+15195040098',
        content,
        metadata: { isGroup: false, ...metadata },
      }));
    }

    it('shows a verified contact the entries sent to them, and never the global list', async () => {
      const harness = buildHarness(makeResolver({ systemRole: null, tier: 'trusted' }));
      harness.getActiveForRecipient.mockResolvedValueOnce([lunchAsk]);
      await sendFromContact(harness);

      const task = harness.tasks[0]!;
      expect(task.payload.liveTurn).toBe(false);
      expect(harness.getActive).not.toHaveBeenCalled();
      expect(harness.getActiveForRecipient).toHaveBeenCalledWith('contact-other-1');
      expect(harness.formatInjectionBlock).toHaveBeenCalledWith([lunchAsk], 'Thur Nov 5', 'recipient');
      expect(task.payload.content).toContain('efc521b3-4ef1-40ca-a34f-63f18629fe21');
      expect(task.payload.content).toContain('Thur Nov 5');
      expect(task.payload.turnGuidance).toEqual(['non-principal-reply-shaped', 'recipient-outbound-context']);
    });

    it('records the sender\'s own text on the entries it was shown', async () => {
      const harness = buildHarness(makeResolver({ systemRole: null, tier: 'trusted' }));
      harness.getActiveForRecipient.mockResolvedValueOnce([lunchAsk]);
      await sendFromContact(harness);

      expect(harness.recordReply).toHaveBeenCalledWith(
        ['efc521b3-4ef1-40ca-a34f-63f18629fe21'],
        { from: 'Other Contact', contactId: 'contact-other-1', content: 'Thur Nov 5' },
      );
    });

    it('records an email without its Subject line and the quoted thread', async () => {
      const harness = buildHarness(makeResolver({ systemRole: null, tier: 'trusted' }));
      harness.getActiveForRecipient.mockResolvedValueOnce([lunchAsk]);
      await harness.bus.publish('channel', createInboundMessage({
        conversationId: 'email:thread-lunch',
        channelId: 'email',
        senderId: 'xiaopu@example.com',
        content: 'Subject: Re: Lunch\n\nThur Nov 5 works.\n\nOn Tue, Oct 20, 2026 at 9:00 AM Curia <curia@example.com> wrote:\n> Which day works?',
        metadata: { senderVerified: true, curiaRole: 'to', otherRecipientCount: 0 },
      }));

      expect(harness.recordReply).toHaveBeenCalledWith(
        ['efc521b3-4ef1-40ca-a34f-63f18629fe21'],
        expect.objectContaining({ content: 'Thur Nov 5 works.' }),
      );
    });

    it('still injects the block when recording the reply fails', async () => {
      const harness = buildHarness(makeResolver({ systemRole: null, tier: 'trusted' }));
      harness.getActiveForRecipient.mockResolvedValueOnce([lunchAsk]);
      harness.recordReply.mockRejectedValueOnce(new Error('db down'));
      await sendFromContact(harness);

      expect(harness.tasks[0]!.payload.content).toContain('efc521b3-4ef1-40ca-a34f-63f18629fe21');
    });

    it('adds nothing when no active entry was sent to this sender', async () => {
      const harness = buildHarness(makeResolver({ systemRole: null, tier: 'trusted' }));
      await sendFromContact(harness);

      expect(harness.tasks[0]!.payload.content).toBe('Thur Nov 5');
      expect(harness.recordReply).not.toHaveBeenCalled();
      expect(harness.tasks[0]!.payload.turnGuidance).toEqual(['non-principal-reply-shaped']);
    });

    it('does not read entries for an unverified contact', async () => {
      const harness = buildHarness(makeResolver({ systemRole: null, tier: 'known', verified: false }));
      await sendFromContact(harness);

      expect(harness.getActiveForRecipient).not.toHaveBeenCalled();
      expect(harness.recordReply).not.toHaveBeenCalled();
    });

    // A verified identity says the address is the contact's, not that this message is from
    // them: a forged From of a verified address must not get the block or a recorded message.
    it('reads entries for email only when SPF, DKIM and DMARC passed', async () => {
      const send = (harness: ReturnType<typeof buildHarness>, senderVerified: boolean) =>
        harness.bus.publish('channel', createInboundMessage({
          conversationId: 'email:thread-lunch',
          channelId: 'email',
          senderId: 'xiaopu@example.com',
          content: 'Thur Nov 5',
          metadata: { senderVerified, curiaRole: 'to', otherRecipientCount: 0 },
        }));

      const forged = buildHarness(makeResolver({ systemRole: null, tier: 'trusted' }));
      forged.getActiveForRecipient.mockResolvedValue([lunchAsk]);
      await send(forged, false);
      expect(forged.getActiveForRecipient).not.toHaveBeenCalled();
      expect(forged.recordReply).not.toHaveBeenCalled();
      expect(forged.tasks[0]!.payload.content).not.toContain('[ACTIVE OUTBOUND CONTEXT');

      const authenticated = buildHarness(makeResolver({ systemRole: null, tier: 'trusted' }));
      authenticated.getActiveForRecipient.mockResolvedValue([lunchAsk]);
      await send(authenticated, true);
      expect(authenticated.getActiveForRecipient).toHaveBeenCalledWith('contact-other-1');
    });

    it('does not read entries for SMS, whose From is spoofable (ADR-036)', async () => {
      const harness = buildHarness(makeResolver({ systemRole: null, tier: 'trusted' }));
      harness.getActiveForRecipient.mockResolvedValue([lunchAsk]);
      await harness.bus.publish('channel', createInboundMessage({
        conversationId: 'sms:+15195040098',
        channelId: 'sms',
        senderId: '+15195040098',
        content: 'Thur Nov 5',
      }));

      expect(harness.getActiveForRecipient).not.toHaveBeenCalled();
      expect(harness.recordReply).not.toHaveBeenCalled();
    });

    // The block shows what Curia sent one person. Where the reply reaches anyone else, they
    // would see it, and their chatter would be recorded as that person's message.
    describe('only in a one-to-one conversation', () => {
      async function expectNoBlock(message: Parameters<typeof createInboundMessage>[0]) {
        const harness = buildHarness(makeResolver({ systemRole: null, tier: 'trusted' }));
        harness.getActiveForRecipient.mockResolvedValue([lunchAsk]);
        await harness.bus.publish('channel', createInboundMessage(message));
        expect(harness.getActiveForRecipient).not.toHaveBeenCalled();
        expect(harness.recordReply).not.toHaveBeenCalled();
        expect(harness.tasks[0]!.payload.content).not.toContain('[ACTIVE OUTBOUND CONTEXT');
        expect(harness.tasks[0]!.payload.content).not.toContain('efc521b3');
      }

      it('not in a Signal group', () => expectNoBlock({
        conversationId: 'signal:group=Z3JvdXAtaWQ=', channelId: 'signal', senderId: '+15195040098',
        content: 'hey all, what time does the offsite start?', metadata: { isGroup: true, groupId: 'Z3JvdXAtaWQ=' },
      }));

      it('not for a Signal message whose adapter metadata is missing', () => expectNoBlock({
        conversationId: 'signal:+15195040098', channelId: 'signal', senderId: '+15195040098', content: 'Thur Nov 5',
      }));

      it('not in a Slack channel thread', () => expectNoBlock({
        conversationId: 'slack:C123:1700000000.000100', channelId: 'slack', senderId: 'U123',
        content: 'Thur Nov 5', metadata: { isDm: false, slackChannel: 'C123', eventType: 'app_mention' },
      }));

      it('not on an email where Curia is only CC\'d', () => expectNoBlock({
        conversationId: 'email:thread-cc', channelId: 'email', senderId: 'xiaopu@example.com',
        content: 'Thur Nov 5', metadata: { senderVerified: true, curiaRole: 'cc', otherRecipientCount: 1 },
      }));

      it('not on an email with anyone else on To or CC', () => expectNoBlock({
        conversationId: 'email:thread-group', channelId: 'email', senderId: 'xiaopu@example.com',
        content: 'Thur Nov 5', metadata: { senderVerified: true, curiaRole: 'to', otherRecipientCount: 2 },
      }));

      it('not on an email whose recipient count is unknown', () => expectNoBlock({
        conversationId: 'email:thread-unknown', channelId: 'email', senderId: 'xiaopu@example.com',
        content: 'Thur Nov 5', metadata: { senderVerified: true, curiaRole: 'to' },
      }));

      it('in a Slack DM', async () => {
        const harness = buildHarness(makeResolver({ systemRole: null, tier: 'trusted' }));
        harness.getActiveForRecipient.mockResolvedValue([lunchAsk]);
        await harness.bus.publish('channel', createInboundMessage({
          conversationId: 'slack:D123', channelId: 'slack', senderId: 'U123', content: 'Thur Nov 5',
          metadata: { isDm: true, slackChannel: 'D123', eventType: 'message' },
        }));
        expect(harness.getActiveForRecipient).toHaveBeenCalledWith('contact-other-1');
      });
    });

    it('does not read entries for an unresolved sender', async () => {
      const harness = buildHarness(makeResolver({ resolved: false }));
      await sendFromContact(harness);

      expect(harness.getActiveForRecipient).not.toHaveBeenCalled();
    });

    it('does not read entries for auto-generated mail', async () => {
      const harness = buildHarness(makeResolver({ systemRole: null, tier: 'trusted' }));
      await harness.bus.publish('channel', createInboundMessage({
        conversationId: 'email:thread-auto',
        channelId: 'email',
        senderId: 'noreply@example.com',
        content: 'Your receipt',
        metadata: { isAutoGenerated: true, autoGeneratedSignals: ['auto-submitted'] },
      }));

      expect(harness.getActiveForRecipient).not.toHaveBeenCalled();
    });

    it('a principal turn still reads the global list, not the recipient one', async () => {
      const harness = buildHarness(makeResolver({ systemRole: 'principal', tier: 'principal' }));
      await sendFromContact(harness, 'Any luck with Xiaopu?');

      expect(harness.getActive).toHaveBeenCalledOnce();
      expect(harness.getActiveForRecipient).not.toHaveBeenCalled();
      expect(harness.recordReply).not.toHaveBeenCalled();
    });
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

  describe('turn guidance (#1959)', () => {
    it('names the block guidance, and the sub-rule its entry needs, when the block is injected', async () => {
      const { bus, tasks } = buildHarness(makeResolver({ systemRole: 'principal', tier: 'principal' }));
      await bus.publish('channel', createInboundMessage({
        conversationId: 'signal:+15551234567',
        channelId: 'signal',
        senderId: '+15551234567',
        content: 'Yes, Thursday works',
      }));
      expect(tasks[0]!.payload.turnGuidance).toEqual(['outbound-context', 'outbound-context-task-wake']);
      // The guidance travels beside the content, never inside it: working memory keeps
      // `content`, and a copy per earlier turn would pile up in history.
      expect(tasks[0]!.payload.content).not.toContain(TURN_GUIDANCE_HEADER);
    });

    it('names the reply-shaped note when a principal turn has no block', async () => {
      const { bus, tasks, getActive } = buildHarness(makeResolver({ systemRole: 'principal', tier: 'principal' }));
      getActive.mockResolvedValueOnce([]);
      await bus.publish('channel', createInboundMessage({
        conversationId: 'signal:+15551234567',
        channelId: 'signal',
        senderId: '+15551234567',
        content: 'Go ahead',
      }));
      expect(tasks[0]!.payload.turnGuidance).toEqual(['principal-reply-shaped']);
    });

    it('names the non-principal and email guidance for an outside sender\'s email', async () => {
      const { bus, tasks } = buildHarness(makeResolver({ systemRole: null, tier: 'known' }));
      await bus.publish('channel', createInboundMessage({
        conversationId: 'email:thread-third-party',
        channelId: 'email',
        senderId: 'external@example.com',
        content: 'Can we meet Thursday?',
      }));
      expect(tasks[0]!.payload.turnGuidance).toEqual([
        'non-principal-reply-shaped',
        'email-direct-reply',
        'email-etiquette',
      ]);
    });

    it('names the CC guidance when the principal CCs Curia', async () => {
      const { bus, tasks } = buildHarness(makeResolver({ systemRole: 'principal', tier: 'principal' }));
      await bus.publish('channel', createInboundMessage({
        conversationId: 'email:thread-cc',
        channelId: 'email',
        senderId: 'ceo@example.com',
        content: 'Looping in my assistant.',
        metadata: { curiaRole: 'cc', primaryRecipientEmails: ['nik@example.com'] },
      }));
      expect(tasks[0]!.payload.turnGuidance).toEqual([
        'outbound-context',
        'outbound-context-task-wake',
        'email-cc-principal',
        'email-cc-reply',
        'email-etiquette',
      ]);
    });
  });
});
