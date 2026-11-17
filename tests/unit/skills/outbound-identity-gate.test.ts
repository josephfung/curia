import { describe, it, expect, vi } from 'vitest';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import type { NylasClient } from '../../../src/channels/email/nylas-client.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';
import { ConversationEntityState } from '../../../src/entity-context/conversation-entities.js';
import type { ResolvedEntityCard } from '../../../src/agents/resolved-entities.js';
import type { IdentityGateMode } from '../../../src/config.js';
import type { Logger } from '../../../src/logger.js';
import type { AgentPersona } from '../../../src/skills/types.js';
import type { SignalRpcClient } from '../../../src/channels/signal/signal-rpc-client.js';

const XIAOPU = '11111111-1111-4111-8111-111111111111';
const TASK = 'task-turn-3';

function card(): ResolvedEntityCard {
  return {
    contactId: XIAOPU,
    displayName: 'Xiaopu Chen',
    preferredName: null,
    role: 'Spouse',
    organization: null,
    primaryEmail: 'chen@example.com',
    primaryPhone: null,
  };
}

function gateway(
  entities: ConversationEntityState,
  options?: { identityGate?: IdentityGateMode; contactService?: ContactService; agentPersona?: AgentPersona },
) {
  const nylasClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 'msg-123' }),
  } as unknown as NylasClient;
  const contactService = options?.contactService ?? ({
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
    // The gate reads the principal's name; without this the read throws, which the gate now
    // reports as a failed lookup (#2587).
    getContact: vi.fn().mockResolvedValue(null),
  } as unknown as ContactService);
  const contentFilter = {
    check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
  } as unknown as OutboundContentFilter;
  const bus = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
  } as unknown as EventBus;
  const warn = vi.fn();
  const logger = {
    child() { return this; },
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
  const signalClient = {
    send: vi.fn().mockResolvedValue(undefined),
    sendReadReceipt: vi.fn().mockResolvedValue(undefined),
    listGroups: vi.fn().mockResolvedValue([]),
    isConnected: vi.fn().mockReturnValue(true),
  };
  const gw = new OutboundGateway({
    nylasClients: new Map([['curia', nylasClient]]),
    signalClient: signalClient as unknown as SignalRpcClient,
    signalPhoneNumber: '+15555550000',
    contactService,
    contentFilter,
    bus,
    principalIdentities: [{
      id: 'pi-1',
      contactId: 'principal',
      channel: 'email',
      channelIdentifier: 'joseph@example.com',
      label: null,
      verified: true,
      verifiedAt: null,
      source: 'ceo_stated',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }, {
      id: 'pi-2',
      contactId: 'principal',
      channel: 'signal',
      channelIdentifier: '+15555551111',
      label: null,
      verified: true,
      verifiedAt: null,
      source: 'ceo_stated',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }],
    conversationEntities: entities,
    identityGate: options?.identityGate,
    ...(options?.agentPersona ? { agentPersona: options.agentPersona } : {}),
    logger,
  });
  return { gw, nylasClient, signalClient, bus, warn };
}

describe('outbound identity gate (#1818)', () => {
  it('blocks an external send that names a person this turn has not resolved', async () => {
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
    entities.turnIdentities.begin(TASK);
    const { gw, nylasClient } = gateway(entities);

    const result = await gw.send({
      channel: 'email',
      to: 'dani@wrcf.ca',
      subject: 'Registration',
      body: 'He and Xiaopu (last name to be confirmed) would like to attend.\n- Xiaopu (Joseph\'s guest)',
    }, { taskEventId: TASK, conversationId: 'conv-1' });

    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain('Xiaopu');
    expect(result.blockedRules).toEqual(['unresolved-identity']);
    // The gate working as designed: the agent resolves and resends, so not a hiccup (#2587).
    expect(result.policyHold).toBe(true);
    expect(nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('still blocks when a name lookup failed, but as a failure, not a policy hold (#2587)', async () => {
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
    entities.turnIdentities.begin(TASK);
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockRejectedValue(new Error('db down')),
    } as unknown as ContactService;
    const { gw, nylasClient } = gateway(entities, { contactService });

    const result = await gw.send({
      channel: 'email',
      to: 'dani@wrcf.ca',
      subject: 'Registration',
      body: 'He and Xiaopu (last name to be confirmed) would like to attend.\n- Xiaopu (Joseph\'s guest)',
    }, { taskEventId: TASK, conversationId: 'conv-1' });

    // Fail closed as before; the outage may have caused the block, so it stays a hiccup.
    expect(result.success).toBe(false);
    expect(result.blockedRules).toEqual(['unresolved-identity']);
    expect(result.policyHold).toBeUndefined();
    expect(nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('does not block Curia signing with its own name and title (#2192)', async () => {
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
    entities.turnIdentities.begin(TASK);
    const { gw, nylasClient } = gateway(entities, { agentPersona: { displayName: 'Alex Curia', title: 'Digital EA' } });

    const result = await gw.send({
      channel: 'email',
      to: 'dani@wrcf.ca',
      subject: 'RSVP',
      body: 'Thanks for the invitation: Joseph Fung will attend.\nBest,\nAlex Curia\nDigital EA',
    }, { taskEventId: TASK, conversationId: 'conv-1' });

    expect(result.success).toBe(true);
    expect(nylasClient.sendMessage).toHaveBeenCalledOnce();
  });

  it('still blocks an unresolved person when a persona is configured', async () => {
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
    entities.turnIdentities.begin(TASK);
    const { gw, nylasClient } = gateway(entities, { agentPersona: { displayName: 'Alex Curia', title: 'Digital EA' } });

    const result = await gw.send({
      channel: 'email',
      to: 'dani@wrcf.ca',
      subject: 'Registration',
      body: 'He and Xiaopu (last name to be confirmed) would like to attend.',
    }, { taskEventId: TASK, conversationId: 'conv-1' });

    expect(result.success).toBe(false);
    expect(result.blockedRules).toEqual(['unresolved-identity']);
    expect(nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  // Only the full persona name is exempt: a guest who shares its first name is still a person.
  it("blocks a guest who shares the persona's first name, while the full signature passes", async () => {
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
    entities.turnIdentities.begin(TASK);
    const { gw, nylasClient } = gateway(entities, { agentPersona: { displayName: 'Alex Curia', title: 'Digital EA' } });

    const result = await gw.send({
      channel: 'email',
      to: 'dani@wrcf.ca',
      subject: 'RSVP',
      body: 'Joseph Fung will attend with Alex.\nBest,\nAlex Curia\nDigital EA',
    }, { taskEventId: TASK, conversationId: 'conv-1' });

    expect(result.success).toBe(false);
    expect(result.blockedRules).toEqual(['unresolved-identity']);
    expect(nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('names the unresolved words in the blocked event, so a relayed reply\'s rewrite can fix them (#2192)', async () => {
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
    entities.turnIdentities.begin(TASK);
    const { gw, bus } = gateway(entities);

    await gw.send({
      channel: 'email',
      to: 'dani@wrcf.ca',
      subject: 'Registration',
      body: 'Xiaopu Chen would like to attend.',
    }, { taskEventId: TASK, conversationId: 'conv-1' });

    const blocked = vi.mocked(bus.publish).mock.calls
      .map(([, event]) => event)
      .find((event) => event.type === 'outbound.blocked');
    expect(blocked?.type).toBe('outbound.blocked');
    if (blocked?.type !== 'outbound.blocked') return;
    expect(blocked.payload.findings[0]!.detail).toContain('Xiaopu Chen');
  });

  it('names a recipient that matches no contact, since its reason says only "an external recipient" (#2033)', async () => {
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
    entities.turnIdentities.begin(TASK);
    // The default mock resolves no contact for any address.
    const { gw } = gateway(entities);

    const result = await gw.send({
      channel: 'email',
      to: 'joseph@joseph.example',
      subject: 'Registration',
      body: 'He and Xiaopu (last name to be confirmed) would like to attend.',
    }, { taskEventId: TASK, conversationId: 'conv-1' });

    expect(result.success).toBe(false);
    expect(result.blockedRules).toEqual(['unresolved-identity']);
    expect(result.blockedReason).toContain('joseph@joseph.example matches no known contact');
    expect(result.unmatchedRecipients).toEqual(['joseph@joseph.example']);
  });

  it('allows the send once the full name is resolved in this turn', async () => {
    const entities = ConversationEntityState.createInMemory({ get: () => card() }, ['Joseph Fung']);
    entities.turnIdentities.begin(TASK);
    entities.turnIdentities.replace(TASK, [card()]);
    const { gw, nylasClient } = gateway(entities);

    const result = await gw.send({
      channel: 'email',
      to: 'dani@wrcf.ca',
      subject: 'Registration',
      body: 'He and Xiaopu Chen would like to attend.\n- Joseph Fung\n- Xiaopu Chen',
    }, { taskEventId: TASK, conversationId: 'conv-1' });

    expect(result.success).toBe(true);
    expect(nylasClient.sendMessage).toHaveBeenCalledOnce();
  });

  it('does not gate a message to the principal', async () => {
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
    entities.turnIdentities.begin(TASK);
    const { gw, nylasClient } = gateway(entities);

    const result = await gw.send({
      channel: 'email',
      to: 'joseph@example.com',
      subject: 'Registration',
      body: 'I still need Xiaopu\'s last name.',
    }, { taskEventId: TASK, conversationId: 'conv-1' });

    expect(result.success).toBe(true);
    expect(nylasClient.sendMessage).toHaveBeenCalledOnce();
  });

  it('reports a blocked recipient instead of an unresolved identity', async () => {
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
    entities.turnIdentities.begin(TASK);
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        tier: 'blocked',
        contactId: 'blocked-1',
        displayName: 'Dani',
      }),
    } as unknown as ContactService;
    const { gw, nylasClient } = gateway(entities, { contactService });

    const result = await gw.send({
      channel: 'email',
      to: 'dani@wrcf.ca',
      subject: 'Registration',
      body: 'He and Xiaopu (last name to be confirmed) would like to attend.',
    }, { taskEventId: TASK, conversationId: 'conv-1' });

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Recipient is blocked');
    expect(nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('does not block a title-case subject on a clean body', async () => {
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
    entities.turnIdentities.begin(TASK);
    const { gw, nylasClient } = gateway(entities);

    const result = await gw.send({
      channel: 'email',
      to: 'dani@wrcf.ca',
      subject: 'Quarterly Planning Session',
      body: 'I have shared the deck on Google Drive.',
    }, { taskEventId: TASK, conversationId: 'conv-1' });

    expect(result.success).toBe(true);
    expect(nylasClient.sendMessage).toHaveBeenCalledOnce();
  });

  it('logs and sends when the gate is in shadow mode', async () => {
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
    entities.turnIdentities.begin(TASK);
    const { gw, nylasClient, warn } = gateway(entities, { identityGate: 'shadow' });

    const result = await gw.send({
      channel: 'email',
      to: 'dani@wrcf.ca',
      subject: 'Registration',
      body: 'He and Xiaopu (last name to be confirmed) would like to attend.',
    }, { taskEventId: TASK, conversationId: 'conv-1' });

    expect(result.success).toBe(true);
    expect(nylasClient.sendMessage).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ identityGate: 'shadow' }),
      expect.stringContaining('would have blocked'),
    );
  });

  it('does not inspect the body when the gate is off', async () => {
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
    entities.turnIdentities.begin(TASK);
    const { gw, nylasClient, warn } = gateway(entities, { identityGate: 'off' });

    const result = await gw.send({
      channel: 'email',
      to: 'dani@wrcf.ca',
      subject: 'Registration',
      body: 'He and Xiaopu (last name to be confirmed) would like to attend.',
    }, { taskEventId: TASK, conversationId: 'conv-1' });

    expect(result.success).toBe(true);
    expect(nylasClient.sendMessage).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('unresolved identity'),
    );
  });

  // Scenario 47b: a relayed Signal reply to the principal naming a contact the turn never
  // resolved. Only a send whose every recipient is a verified principal identity skips the gate.
  describe('audience on a relayed reply', () => {
    const relay = { taskEventId: TASK, conversationId: 'signal:+15555551111', postTurn: true } as const;
    // The draft the 47b gate run blocked.
    const REPLY = 'Already handled — that\'s the same sync I booked a few minutes ago: 30 minutes with Priya Raman '
      + 'on Thursday, November 19 at 3pm, invite sent.';

    it('passes a Signal reply whose only recipient is the principal', async () => {
      const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
      entities.turnIdentities.begin(TASK);
      const { gw, signalClient } = gateway(entities);

      const result = await gw.send({
        channel: 'signal', recipient: '+15555551111', message: REPLY,
      }, relay);

      expect(result.success).toBe(true);
      expect(signalClient.send).toHaveBeenCalledOnce();
      // The destination, not just the call: a substituted recipient must fail this test.
      expect(signalClient.send).toHaveBeenCalledWith(expect.objectContaining({ recipient: ['+15555551111'], message: expect.stringContaining('Already handled') }));
    });

    it('still blocks the same Signal reply to anyone else', async () => {
      const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
      entities.turnIdentities.begin(TASK);
      const { gw, signalClient } = gateway(entities);

      const result = await gw.send({
        channel: 'signal', recipient: '+15555552222', message: REPLY,
      }, { ...relay, conversationId: 'signal:+15555552222' });

      expect(result.success).toBe(false);
      expect(result.blockedRules).toEqual(['unresolved-identity']);
      expect(signalClient.send).not.toHaveBeenCalled();
    });

    it('still blocks an email to the principal with someone else on CC', async () => {
      const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Joseph Fung']);
      entities.turnIdentities.begin(TASK);
      const { gw, nylasClient } = gateway(entities);

      const result = await gw.send({
        channel: 'email',
        to: 'joseph@example.com',
        cc: ['dani@wrcf.ca'],
        subject: 'Sync',
        body: REPLY,
      }, { taskEventId: TASK, conversationId: 'conv-1' });

      expect(result.success).toBe(false);
      expect(result.blockedRules).toEqual(['unresolved-identity']);
      expect(nylasClient.sendMessage).not.toHaveBeenCalled();
    });
  });
});
