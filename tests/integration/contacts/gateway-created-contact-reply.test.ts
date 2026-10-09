// A reply from a contact the outbound gateway created (#2040, #2071, ADR-047).
//
// After a send reaches an address with no contact, the gateway records a `known`
// contact. send-draft leaves an unverified `outbound_recipient` identity.
// The email-reply handler passes `email_participant` only after it has checked
// that the From is not an owned mailbox and that SPF, DKIM, and DMARC passed.
// This file calls send() with that option directly; the gateway then verifies
// the identity when the duplicate check is clear. These tests take that contact
// through the real chain:
//   1. the gateway creates it after a send;
//   2. the dispatcher routes the person's reply, even on a channel whose
//      unknown_sender policy is `ignore`;
//   3. Gate C allows a relay of that reply to the principal.
// The last case lowers the same contact to `unknown` and shows why the tier
// matters: the reply is dropped, and the relay escalates.

import { it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import {
  createInboundMessage,
  type AgentTaskEvent,
  type MessageRejectedEvent,
} from '../../../src/bus/events.js';
import type { ChannelIdentity } from '../../../src/contacts/types.js';
import type { NylasClient } from '../../../src/channels/email/nylas-client.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import type { ToolHandler, ToolManifest } from '../../../src/skills/types.js';
import {
  describeIf,
  makeRunId,
  createContactStack,
  type ContactTestStack,
} from './harness.js';

describeIf('Reply from a gateway-created contact (#2040)', () => {
  let stack: ContactTestStack;
  let principalIdentity: ChannelIdentity;
  const runId = makeRunId();

  beforeAll(async () => {
    stack = await createContactStack();

    // A stand-in principal: Gate C's carve-out and the `principal` send alias read
    // the principal identity snapshot, so its contact must exist in the store.
    const principal = await stack.contactService.createContact({
      displayName: `Principal ${runId}`,
      source: 'ceo_stated',
    });
    stack.trackContact(principal.id, principal.kgNodeId);
    principalIdentity = await stack.contactService.linkIdentity({
      contactId: principal.id,
      channel: 'email',
      channelIdentifier: `principal-${runId}@example.com`,
      source: 'ceo_stated',
    });
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  function makeGateway(): OutboundGateway {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: `sent-${runId}` }),
      sendDraft: vi.fn().mockResolvedValue({ id: `sent-draft-${runId}` }),
    } as unknown as NylasClient;
    const contentFilter = {
      check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
    } as unknown as OutboundContentFilter;
    const bus = { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() } as unknown as EventBus;
    return new OutboundGateway({
      nylasClients: new Map([['curia', nylasClient]]),
      contactService: stack.contactService,
      contentFilter,
      bus,
      principalIdentities: [principalIdentity],
      logger: stack.logger,
    });
  }

  /** The two gateway paths that still create a contact after #2041. */
  const creationPaths = [
    {
      name: 'send-draft',
      source: 'outbound_recipient' as const,
      verified: false,
      send: (gateway: OutboundGateway, address: string) =>
        gateway.sendEmailDraft(
          `draft-${runId}`,
          'curia',
          { recipientEmail: address, body: 'Confirming the venue for the 14th.', subject: 'Venue' },
          { humanApproved: true },
        ),
    },
    {
      name: 'email-reply',
      // The handler passes this option. replyToMessageId alone does not (#2071).
      source: 'email_participant' as const,
      verified: true,
      send: (gateway: OutboundGateway, address: string) =>
        gateway.send({
          channel: 'email',
          to: address,
          subject: 'Re: Venue',
          body: 'Thanks, the 14th works.',
          replyToMessageId: `msg-${runId}`,
        }, { recipientSource: 'email_participant' }),
    },
  ] as const;

  /** Send through the gateway to an address with no contact, and return the contact it made. */
  async function createViaGateway(path: (typeof creationPaths)[number], address: string) {
    const result = await path.send(makeGateway(), address);
    expect(result.success).toBe(true);

    const resolved = await stack.contactService.resolveByChannelIdentity('email', address);
    expect(resolved).not.toBeNull();
    const contact = await stack.contactService.getContact(resolved!.contactId);
    stack.trackContact(resolved!.contactId, contact?.kgNodeId);
    return resolved!;
  }

  function wireDispatch(unknownSender: 'allow' | 'ignore') {
    const bus = new EventBus(stack.logger);
    const dispatcher = new Dispatcher({
      bus,
      logger: stack.logger,
      contactResolver: stack.resolver,
      channelPolicies: { email: { trust: 'low', unknownSender, threaded: true } },
    });
    dispatcher.register();

    const rejectedEvents: MessageRejectedEvent[] = [];
    const taskEvents: AgentTaskEvent[] = [];
    bus.subscribe('message.rejected', 'system', (e) => { rejectedEvents.push(e as MessageRejectedEvent); });
    bus.subscribe('agent.task', 'agent', (e) => { taskEvents.push(e as AgentTaskEvent); });
    return { bus, rejectedEvents, taskEvents };
  }

  async function deliverReply(unknownSender: 'allow' | 'ignore', address: string) {
    const wired = wireDispatch(unknownSender);
    await wired.bus.publish('channel', createInboundMessage({
      conversationId: `email:${address}:reply`,
      channelId: 'email',
      senderId: address,
      content: 'The 14th is booked. Can you confirm the headcount?',
    }));
    return wired;
  }

  /**
   * Gate C on a relay to the principal: the coordinator forwarding the reply with
   * email-send to "principal", under the originator the dispatcher stamped.
   */
  async function relayToPrincipal(task: AgentTaskEvent, address: string) {
    const registry = new ToolRegistry();
    const manifest: ToolManifest = {
      name: 'email-send',
      description: 'email-send stub',
      version: '1.0.0',
      sensitivity: 'normal',
      action_risk: 'medium',
      inputs: {},
      outputs: {},
      permissions: [],
      secrets: [],
      timeout: 5000,
    };
    const handler: ToolHandler = { execute: vi.fn().mockResolvedValue({ success: true, data: 'sent' }) };
    registry.register(manifest, handler);

    const autonomyService = {
      getConfig: vi.fn().mockResolvedValue({ score: 100, band: 'full', updatedAt: new Date(), updatedBy: 'test' }),
    } as unknown as AutonomyService;
    const layer = new ExecutionLayer(registry, stack.logger, {
      autonomyService,
      contactService: stack.contactService,
      principalIdentities: [principalIdentity],
    });

    const result = await layer.invoke(
      'email-send',
      { to: 'principal', subject: 'Fwd: Venue', body: 'The venue asks for a headcount.' },
      undefined,
      { senderId: address, taskMetadata: task.payload.metadata },
    );
    return { result, handler };
  }

  for (const path of creationPaths) {
    it(`${path.name}: the gateway creates a known contact with source ${path.source}`, async () => {
      const address = `venue-${path.name}-${runId}@example.com`;
      const resolved = await createViaGateway(path, address);

      expect(resolved.tier).toBe('known');
      const identities = await stack.contactService.getIdentitiesForContact(resolved.contactId);
      expect(identities).toHaveLength(1);
      expect(identities[0]).toMatchObject({ source: path.source, verified: path.verified });
    });

    it(`${path.name}: the reply is routed under unknown_sender=ignore, and a relay to the principal is allowed`, async () => {
      const address = `reply-${path.name}-${runId}@example.com`;
      const resolved = await createViaGateway(path, address);

      const { rejectedEvents, taskEvents } = await deliverReply('ignore', address);
      expect(rejectedEvents).toHaveLength(0);
      expect(taskEvents).toHaveLength(1);
      const task = taskEvents[0]!;
      expect(task.payload.metadata?.['originator']).toMatchObject({
        contactId: resolved.contactId,
        tier: 'known',
      });

      const { result, handler } = await relayToPrincipal(task, address);
      expect(result.success).toBe(true);
      expect(handler.execute).toHaveBeenCalledOnce();
    });
  }

  it('the same contact at unknown: the reply is dropped under ignore, and the relay escalates', async () => {
    const address = `stranger-${runId}@example.com`;
    const resolved = await createViaGateway(creationPaths[0], address);
    await stack.contactService.setTier(resolved.contactId, 'unknown');

    const ignored = await deliverReply('ignore', address);
    expect(ignored.taskEvents).toHaveLength(0);
    expect(ignored.rejectedEvents).toHaveLength(1);

    const allowed = await deliverReply('allow', address);
    expect(allowed.taskEvents).toHaveLength(1);
    const task = allowed.taskEvents[0]!;
    expect(task.payload.metadata?.['originator']).toMatchObject({ tier: 'unknown' });

    const { result, handler } = await relayToPrincipal(task, address);
    expect(result.success).toBe(false);
    expect(handler.execute).not.toHaveBeenCalled();
  });
});
