import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import type { BusEvent, OutboundDeliveredEvent } from '../../src/bus/events.js';
import type { SkillManifest } from '../../src/skills/types.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../src/dispatch/outbound-filter.js';
import type { OutboundContextService } from '../../src/dispatch/outbound-context.js';
import { SignalSendHandler } from '../../skills/signal-send/handler.js';
import signalSendManifest from '../../skills/signal-send/skill.json' with { type: 'json' };

const logger = pino({ level: 'silent' });

describe('outbound.delivered emission (#729)', () => {
  it('signal-send invocation publishes one outbound.delivered event with full payload', async () => {
    const bus = new EventBus(logger);
    const captured: BusEvent[] = [];

    // Capture both skill.result and outbound.delivered events to validate the full pipeline.
    bus.subscribe('outbound.delivered', 'system', async (evt) => { captured.push(evt); });
    bus.subscribe('skill.result', 'system', async (evt) => { captured.push(evt); });

    // Mock signal-cli RPC client — send resolves to undefined (success), listGroups
    // returns empty array (used only for group sends, irrelevant for 1:1).
    const signalClient = {
      send: vi.fn().mockResolvedValue(undefined),
      listGroups: vi.fn().mockResolvedValue([]),
    };

    // Mock ContactService — resolveByChannelIdentity is called twice:
    //   1. In OutboundGateway.send() Step 1 (blocked-contact check + trust capture)
    //   2. In promoteOrCreateRecipientContact() after dispatch (promotion check)
    // Both calls return a confirmed contact so the promote path is a no-op (no
    // createContact, linkIdentity, or setStatus calls are made).
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: 'contact-int-1',
        displayName: 'Integration Test Recipient',
        role: null,
        tier: 'known',
        kgNodeId: null,
        verified: true,
      }),
    } as unknown as ContactService;

    // Mock OutboundContentFilter — passes all messages (no blocking in this test path).
    const contentFilter = {
      check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
    } as unknown as OutboundContentFilter;

    // Mock OutboundContextService — used by the execution layer to build a
    // ScopedOutboundContext for skills that declare the outboundContext capability.
    // signal-send calls registerOutboundContext() after a successful send;
    // register() resolves to a string entry ID, release() is not called here.
    const outboundContextService = {
      defaultExpiryHours: 6,
      explicitExpiryHours: 24,
      register: vi.fn().mockResolvedValue('ctx-entry-int-1'),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as OutboundContextService;

    // Build a real OutboundGateway using the mocked transports. No email clients,
    // no autonomy service, no PII redactor — all optional, so their absence means
    // the corresponding gates are skipped (fail-open per OutboundGateway design).
    const outboundGateway = new OutboundGateway({
      signalClient,
      signalPhoneNumber: '+15550001111',
      contactService,
      contentFilter,
      bus,
      principalIdentities: [],
      logger,
    });

    // Register the signal-send skill with the real manifest and handler.
    const registry = new SkillRegistry();
    registry.register(signalSendManifest as SkillManifest, new SignalSendHandler());

    // Build the real ExecutionLayer wired with the gateway, bus, contactService,
    // and outboundContextService. The signal-send manifest declares both
    // 'outboundGateway' and 'outboundContext' capabilities — both must be present
    // or the execution layer's fail-closed capability guard returns an error before
    // the handler runs.
    const executionLayer = new ExecutionLayer(registry, logger, {
      bus,
      outboundGateway,
      contactService,
      outboundContextService,
    });

    // caller is the third argument (CallerContext — contactId/role/channel for the invoker);
    // options is the fourth argument (InvokeOptions — agentId, taskEventId, conversationId, channelId).
    // The gateway reads ctx.taskEventId and ctx.conversationId from options, not from caller,
    // so taskEventId/conversationId must go in the fourth argument for them to reach the payload.
    const result = await executionLayer.invoke(
      'signal-send',
      { recipient: '+15555550199', message: 'audit emission test body' },
      undefined,
      {
        agentId: 'coordinator',
        taskEventId: 'task-int-1',
        conversationId: 'signal:+15555550199',
        channelId: 'signal',
      },
    );

    expect(result.success).toBe(true);

    // The execution layer calls invoke() directly here — no AgentRuntime in the loop,
    // so skill.result events are not published (that happens in the agent layer).
    // The outbound.delivered event is published by OutboundGateway after the wire-level
    // send succeeds, which is the audit signal this test validates.
    const deliveredEvents = captured.filter(
      (e): e is OutboundDeliveredEvent => e.type === 'outbound.delivered',
    );
    expect(deliveredEvents, 'expected exactly one outbound.delivered event').toHaveLength(1);

    expect(deliveredEvents[0]!.payload).toMatchObject({
      channel: 'signal',
      recipientId: '+15555550199',
      recipientContactId: 'contact-int-1',
      content: 'audit emission test body',
      conversationId: 'signal:+15555550199',
      taskEventId: 'task-int-1',
    });
  });
});
