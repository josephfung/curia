import { describe, it, expect, vi } from 'vitest';
import { deliverApprovalToChatChannels } from './approval-channel-notify.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import type { ActionLogRepo } from './action-log-repo.js';
import type { ChannelIdentity } from '../contacts/types.js';
import { createSilentLogger } from '../logger.js';

function identity(channel: string, channelIdentifier: string): ChannelIdentity {
  return {
    id: `id-${channel}`,
    contactId: 'principal-1',
    channel,
    channelIdentifier,
    label: null,
    verified: true,
    verifiedAt: new Date(),
    status: 'active',
    source: 'ceo_stated',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('deliverApprovalToChatChannels', () => {
  it('sends Signal + Slack DMs and binds messageIds', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ success: true, messageId: '1699999999999' })
      .mockResolvedValueOnce({ success: true, messageId: '1710000000.000100' });
    const bindDeliveryMessage = vi.fn().mockResolvedValue(true);

    const result = await deliverApprovalToChatChannels({
      outboundGateway: { send } as unknown as OutboundGateway,
      actionLogRepo: { bindDeliveryMessage } as unknown as ActionLogRepo,
      actionLogId: 7,
      body: 'Reference: abcd1234\nReact 👍 to approve',
      principalIdentities: [
        identity('signal', '+15551234567'),
        identity('slack', 'U_CEO'),
      ],
      logger: createSilentLogger(),
    });

    expect(result).toEqual({ signal: true, slack: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(bindDeliveryMessage).toHaveBeenCalledWith(7, 'signal', '1699999999999');
    expect(bindDeliveryMessage).toHaveBeenCalledWith(7, 'slack', '1710000000.000100');
  });

  it('skips channels without verified principal identities', async () => {
    const send = vi.fn();
    const result = await deliverApprovalToChatChannels({
      outboundGateway: { send } as unknown as OutboundGateway,
      actionLogRepo: { bindDeliveryMessage: vi.fn() } as unknown as ActionLogRepo,
      actionLogId: 7,
      body: 'hi',
      principalIdentities: [identity('email', 'ceo@example.com')],
      logger: createSilentLogger(),
    });
    expect(result).toEqual({ signal: false, slack: false });
    expect(send).not.toHaveBeenCalled();
  });
});
