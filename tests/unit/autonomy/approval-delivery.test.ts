// ApprovalDelivery — one pending approval, one channel, one ping (#2159).
import { describe, it, expect, vi } from 'vitest';
import { ApprovalDelivery } from '../../../src/autonomy/approval-delivery.js';
import type { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';
import type { ActionLogRow } from '../../../src/autonomy/action-log-types.js';
import type { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import type { ChannelIdentity, PrincipalEmailRef } from '../../../src/contacts/types.js';
import type { Logger } from '../../../src/logger.js';

function identity(channel: string, channelIdentifier: string, opts: { verified?: boolean; status?: string } = {}): ChannelIdentity {
  return {
    id: `id-${channel}`, contactId: 'principal-1', channel, channelIdentifier, label: null,
    verified: opts.verified ?? true, verifiedAt: null, status: (opts.status ?? 'active') as ChannelIdentity['status'],
    source: 'ceo_stated', createdAt: new Date(), updatedAt: new Date(),
  };
}

function makeRow(overrides: Partial<ActionLogRow> = {}): ActionLogRow {
  return {
    id: 42, taskId: 'task-1', conversationId: 'email:t1', toolName: 'email-reply', actionRisk: 'medium',
    outcome: 'pending_approval', taskSummary: null, competenceFlag: null, commitmentFlag: null, compatibility: null,
    scoredBy: null, payload: { cc: 'contact-uuid-1', body: 'Thursday works.' }, notificationSentAt: null,
    resolvedAt: null, resolvedBy: null, expiresAt: new Date(Date.now() + 86_400_000), parentActionId: null,
    shortRef: 'abcd1234', description: 'Send email reply: Dana', createdAt: new Date(),
    ...overrides,
  };
}

function makeDelivery(opts: {
  row?: ActionLogRow | null;
  claimed?: boolean;
  sendResult?: { success: boolean; messageId?: string; blockedReason?: string };
  sendThrows?: boolean;
  identities?: ChannelIdentity[];
  principalEmail?: string;
} = {}) {
  const repo = {
    findPendingByShortRef: vi.fn().mockResolvedValue(opts.row === undefined ? makeRow() : opts.row),
    claimNotification: vi.fn().mockResolvedValue(opts.claimed ?? true),
    releaseNotification: vi.fn().mockResolvedValue(undefined),
    bindDeliveryMessage: vi.fn().mockResolvedValue(true),
  };
  const send = opts.sendThrows
    ? vi.fn().mockRejectedValue(new Error('signal down'))
    : vi.fn().mockResolvedValue(opts.sendResult ?? { success: true, messageId: 'msg-1' });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const principalEmail: PrincipalEmailRef = { current: opts.principalEmail ?? 'principal@example.com' };
  const delivery = new ApprovalDelivery({
    actionLogRepo: repo as unknown as ActionLogRepo,
    outboundGateway: { send } as unknown as OutboundGateway,
    principalIdentities: opts.identities ?? [
      identity('signal', '+15550001111'),
      identity('slack', 'U123'),
      identity('email', 'principal@example.com'),
    ],
    principalEmail,
    logger: logger as unknown as Logger,
  });
  return { delivery, repo, send, logger };
}

describe('ApprovalDelivery.availableChannels', () => {
  it('lists verified, active channels in the order signal, sms, slack, email', () => {
    const { delivery } = makeDelivery({
      identities: [
        identity('email', 'principal@example.com'),
        identity('slack', 'U123'),
        identity('sms', '+15550002222'),
        identity('signal', '+15550001111', { verified: false }),
      ],
    });
    expect(delivery.availableChannels()).toEqual(['sms', 'slack', 'email']);
  });

  it('counts email when only the principal email ref is bound', () => {
    const { delivery } = makeDelivery({ identities: [] });
    expect(delivery.availableChannels()).toEqual(['email']);
  });
});

describe('ApprovalDelivery.deliver', () => {
  it('sends once on Signal, binds the message for reactions, and keeps the claim', async () => {
    const { delivery, repo, send } = makeDelivery();

    await expect(delivery.deliver('abcd1234', 'signal')).resolves.toEqual({ delivered: true, channel: 'signal' });

    expect(repo.claimNotification).toHaveBeenCalledWith(42);
    expect(send).toHaveBeenCalledTimes(1);
    const [request, sendOpts] = send.mock.calls[0]!;
    expect(request).toMatchObject({ channel: 'signal', recipient: '+15550001111' });
    expect(request.message).toContain('Reference: abcd1234');
    expect(request.message).toMatch(/React 👍 to approve or 👎 to deny/);
    expect(sendOpts).toEqual({ isSystemNotification: true, skipNotificationOnBlock: true });
    expect(repo.bindDeliveryMessage).toHaveBeenCalledWith(42, 'signal', 'msg-1');
    expect(repo.releaseNotification).not.toHaveBeenCalled();
  });

  it('uses the display registered at raise time, so contact references show as names', async () => {
    const { delivery, send } = makeDelivery();
    delivery.registerDisplay('abcd1234', {
      preamble: 'Curia wanted to send an email reply.',
      payload: { cc: 'Dana Whitfield <dana@example.com>', body: 'Thursday works.' },
    });

    await delivery.deliver('abcd1234', 'slack');

    const request = send.mock.calls[0]![0];
    expect(request).toMatchObject({ channel: 'slack', slackChannelId: 'U123', slackUserId: 'U123' });
    expect(request.message).toContain('Curia wanted to send an email reply.');
    expect(request.message).toContain('Cc: Dana Whitfield');
    expect(request.message).not.toContain('contact-uuid-1');
  });

  it('emails with a reply-to-answer call to action and no reaction binding', async () => {
    const { delivery, send, repo } = makeDelivery({ sendResult: { success: true } });

    await expect(delivery.deliver('abcd1234', 'email')).resolves.toEqual({ delivered: true, channel: 'email' });

    const request = send.mock.calls[0]![0];
    expect(request).toMatchObject({ channel: 'email', to: 'principal@example.com', subject: 'Approval needed — Send email reply: Dana' });
    expect(request.body).toMatch(/Reply approve or deny/);
    expect(repo.bindDeliveryMessage).not.toHaveBeenCalled();
  });

  it('refuses a second delivery: one ping per approval', async () => {
    const { delivery, send } = makeDelivery({ row: makeRow({ notificationSentAt: new Date() }) });

    await expect(delivery.deliver('abcd1234', 'signal')).resolves.toMatchObject({ delivered: false, reason: 'already_delivered' });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses when a concurrent delivery won the claim', async () => {
    const { delivery, send } = makeDelivery({ claimed: false });

    await expect(delivery.deliver('abcd1234', 'signal')).resolves.toMatchObject({ delivered: false, reason: 'already_delivered' });
    expect(send).not.toHaveBeenCalled();
  });

  it('reports an unknown, resolved or expired reference', async () => {
    const { delivery } = makeDelivery({ row: null });

    await expect(delivery.deliver('nope0000', 'signal')).resolves.toMatchObject({ delivered: false, reason: 'not_found' });
  });

  it('refuses a channel the principal has no verified identity on, listing the ones available', async () => {
    const { delivery, repo } = makeDelivery({ identities: [identity('email', 'principal@example.com')] });

    await expect(delivery.deliver('abcd1234', 'signal')).resolves.toEqual({
      delivered: false, reason: 'channel_unavailable', available: ['email'],
    });
    expect(repo.claimNotification).not.toHaveBeenCalled();
  });

  it('releases the claim when the send fails, so another channel or the safety net can try', async () => {
    const { delivery, repo, logger } = makeDelivery({ sendResult: { success: false, blockedReason: 'signal-cli down' } });

    await expect(delivery.deliver('abcd1234', 'signal')).resolves.toEqual({
      delivered: false, reason: 'send_failed', available: ['slack', 'email'],
    });
    expect(repo.releaseNotification).toHaveBeenCalledWith(42);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('releases the claim when the send throws', async () => {
    const { delivery, repo } = makeDelivery({ sendThrows: true });

    await expect(delivery.deliver('abcd1234', 'signal')).resolves.toMatchObject({ delivered: false, reason: 'send_failed' });
    expect(repo.releaseNotification).toHaveBeenCalledWith(42);
  });

  // Review fixes (#2159).
  it('releases the claim when building the message throws, so the approval is not stranded', async () => {
    const { delivery, repo, send } = makeDelivery();
    const payload = {};
    Object.defineProperty(payload, 'cc', { enumerable: true, get: () => { throw new Error('bad payload'); } });
    delivery.registerDisplay('abcd1234', { preamble: 'x', payload });

    await expect(delivery.deliver('abcd1234', 'signal')).resolves.toMatchObject({ delivered: false, reason: 'send_failed' });
    expect(send).not.toHaveBeenCalled();
    // Either never claimed or released: the row must still look undelivered to the safety net.
    expect(repo.claimNotification.mock.calls.length).toBe(repo.releaseNotification.mock.calls.length);
  });

  it('counts a durably queued send as delivered but does not bind the queue id for reactions', async () => {
    const { delivery, repo } = makeDelivery({ sendResult: { success: true, messageId: 'queue-row-9', queued: true } as never });

    await expect(delivery.deliver('abcd1234', 'signal')).resolves.toEqual({ delivered: true, channel: 'signal' });
    expect(repo.bindDeliveryMessage).not.toHaveBeenCalled();
    expect(repo.releaseNotification).not.toHaveBeenCalled();
  });
});
