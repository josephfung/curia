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
  options?: { identityGate?: IdentityGateMode; contactService?: ContactService },
) {
  const nylasClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 'msg-123' }),
  } as unknown as NylasClient;
  const contactService = options?.contactService ?? ({
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
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
  const gw = new OutboundGateway({
    nylasClients: new Map([['curia', nylasClient]]),
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
    }],
    conversationEntities: entities,
    identityGate: options?.identityGate,
    logger,
  });
  return { gw, nylasClient, bus, warn };
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
    expect(nylasClient.sendMessage).not.toHaveBeenCalled();
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
});
