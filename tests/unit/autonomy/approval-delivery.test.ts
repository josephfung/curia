// ApprovalDelivery — one pending approval, one channel, one ping (#2159).
import { describe, it, expect, vi } from 'vitest';
import { ApprovalDelivery } from '../../../src/autonomy/approval-delivery.js';
import type { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';
import type { ActionLogRow, ResolveResult } from '../../../src/autonomy/action-log-types.js';
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
    shortRef: 'abcd1234', approvalNumber: null, description: 'Send email reply: Dana', createdAt: new Date(),
    ...overrides,
  };
}

function makeDelivery(opts: {
  row?: ActionLogRow | null;
  resolve?: ResolveResult;
  claimed?: boolean;
  sendResult?: { success: boolean; messageId?: string; blockedReason?: string };
  sendThrows?: boolean;
  identities?: ChannelIdentity[];
  principalEmail?: string;
  webReachable?: () => boolean;
} = {}) {
  const repo = {
    findPendingByShortRef: vi.fn().mockResolvedValue(opts.row === undefined ? makeRow() : opts.row),
    findPendingByApprovalNumber: vi.fn().mockResolvedValue(opts.row === undefined ? makeRow() : opts.row),
    findAllPending: vi.fn().mockResolvedValue(opts.row === null ? [] : [opts.row ?? makeRow()]),
    resolvePending: vi.fn().mockResolvedValue(opts.resolve ?? (opts.row === null
      ? { found: false, reason: 'not_found', error: 'No pending approval requests' }
      : { found: true, row: opts.row ?? makeRow() })),
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
    webReachable: opts.webReachable,
  });
  return { delivery, repo, send, logger };
}

describe('ApprovalDelivery.availableChannels', () => {
  // SMS never carries an approval (GHSA-p49r-jqh2-v668): a texted "approve 3" cannot approve, since
  // SMS does not authenticate the sender, so an approval there could not be answered there.
  it('lists verified, active channels in the order signal, web, slack, email, never sms', async () => {
    const { delivery } = makeDelivery({
      identities: [
        identity('email', 'principal@example.com'),
        identity('slack', 'U123'),
        identity('sms', '+15550002222'),
        identity('signal', '+15550001111', { verified: false }),
      ],
    });
    expect(await delivery.availableChannels()).toEqual(['slack', 'email']);
  });

  it('offers the phone app between Signal and Slack when a device can receive it', async () => {
    const { delivery } = makeDelivery({
      identities: [
        identity('sms', '+15550002222'),
        identity('slack', 'U123'),
      ],
      webReachable: () => true,
    });
    expect(await delivery.availableChannels()).toEqual(['web', 'slack', 'email']);
  });

  it('counts email when only the principal email ref is bound', async () => {
    const { delivery } = makeDelivery({ identities: [] });
    expect(await delivery.availableChannels()).toEqual(['email']);
  });
});

describe('ApprovalDelivery.deliver', () => {
  it('checks phone reachability once per delivery, and again on the next one', async () => {
    const webReachable = vi.fn(() => true);
    const { delivery, send } = makeDelivery({ webReachable });

    await expect(delivery.deliver('abcd1234', 'web')).resolves.toEqual({ delivered: true, channel: 'web' });
    expect(webReachable).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ channel: 'web', recipient: 'principal' });

    webReachable.mockReturnValue(false);
    await expect(delivery.deliver('abcd1234', 'web')).resolves.toMatchObject({
      delivered: false,
      reason: 'channel_unavailable',
    });
    expect(webReachable).toHaveBeenCalledTimes(2);
  });

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

  it('lists the personal details of a long message the detail block cuts short (#2312)', async () => {
    const { delivery, send } = makeDelivery({ row: makeRow({ toolName: 'email-send' }) });
    delivery.registerDisplay('abcd1234', {
      preamble: 'Held by the send review.',
      payload: { to: 'dana@example.com', subject: 'Forms', body: `${'x'.repeat(600)} call (415) 555-1234` },
    });

    await delivery.deliver('abcd1234', 'signal');

    expect(send.mock.calls[0]![0].message).toContain(
      'Personal details in this message (sent as written if you approve): phone_us (415) 555-1234',
    );
  });

  it('lists them from the stored payload when no display was registered (#2312)', async () => {
    const { delivery, send } = makeDelivery({
      row: makeRow({ toolName: 'dispatcher-relay', payload: { to: 'dana@example.com', body: `${'x'.repeat(600)} call (415) 555-1234` } }),
    });

    await delivery.deliver('abcd1234', 'signal');

    expect(send.mock.calls[0]![0].message).toContain('phone_us (415) 555-1234');
  });

  it('leads a personal-data ask with its question after a restart, rebuilt from the row (#2312)', async () => {
    const { delivery, send } = makeDelivery({
      row: makeRow({
        toolName: 'email-send',
        payload: { to: 'joel@example.com', subject: 'Forms', body: 'My number is (415) 555-1234.' },
        disclosureAsk: { conversationId: 'email:t1', counterparties: ['joel@example.com'], labels: ['phone_us'], requester: 'joel@example.com', taskTitle: 'Book physio' },
      }),
    });

    await delivery.deliver('abcd1234', 'signal');

    const message = String(send.mock.calls[0]![0].message);
    expect(message.startsWith('joel@example.com is asking for your phone number for "Book physio". Share it?')).toBe(true);
    expect(message).toContain('phone_us (415) 555-1234');
  });

  it('emails with a reply-to-answer call to action and no reaction binding', async () => {
    const { delivery, send, repo } = makeDelivery({ sendResult: { success: true } });

    await expect(delivery.deliver('abcd1234', 'email')).resolves.toEqual({ delivered: true, channel: 'email' });

    const request = send.mock.calls[0]![0];
    expect(request).toMatchObject({ channel: 'email', to: 'principal@example.com', subject: 'Approval needed — Send email reply: Dana' });
    expect(request.body).toMatch(/Reply approve or deny/);
    expect(repo.bindDeliveryMessage).not.toHaveBeenCalled();
  });

  // A reply on the approval email's thread is marked as answering it (#2333).
  it('binds the approval email\'s thread, never its message, for a reply to be matched', async () => {
    const { delivery, repo } = makeDelivery({ sendResult: { success: true, messageId: 'nylas-msg-1', threadId: 'nylas-thread-1' } as never });
    await expect(delivery.deliver('abcd1234', 'email')).resolves.toEqual({ delivered: true, channel: 'email' });
    expect(repo.bindDeliveryMessage).toHaveBeenCalledTimes(1);
    expect(repo.bindDeliveryMessage).toHaveBeenCalledWith(42, 'email-thread', 'nylas-thread-1');
  });

  it('binds no thread for a queued email, and still delivers when the binding fails', async () => {
    const queued = makeDelivery({ sendResult: { success: true, messageId: 'queue-row-9', threadId: 't', queued: true } as never });
    await expect(queued.delivery.deliver('abcd1234', 'email')).resolves.toEqual({ delivered: true, channel: 'email' });
    expect(queued.repo.bindDeliveryMessage).not.toHaveBeenCalled();

    const failing = makeDelivery({ sendResult: { success: true, messageId: 'm', threadId: 't' } as never });
    failing.repo.bindDeliveryMessage.mockRejectedValue(new Error('db down'));
    await expect(failing.delivery.deliver('abcd1234', 'email')).resolves.toEqual({ delivered: true, channel: 'email' });
    expect(failing.repo.releaseNotification).not.toHaveBeenCalled();
  });

  // #2159 Phase 3: a numbered approval is shown and answered by its number.
  it('emails a numbered approval with "Approval <n>" and a reply-by-number call to action', async () => {
    const { delivery, send } = makeDelivery({ row: makeRow({ approvalNumber: 3 }), sendResult: { success: true } });

    await delivery.deliver('abcd1234', 'email');

    const body = send.mock.calls[0]![0].body as string;
    expect(body.split('\n')).toContain('Approval 3');
    expect(body).not.toContain('Reference:');
    expect(body).toContain('Reply "approve 3" or "deny 3".');
    expect(body).not.toContain('with the reference');
  });

  it('shows a numbered approval on Signal by number, with the reaction call to action', async () => {
    const { delivery, send } = makeDelivery({ row: makeRow({ approvalNumber: 7 }) });

    await delivery.deliver('abcd1234', 'signal');

    const message = send.mock.calls[0]![0].message as string;
    expect(message.split('\n')).toContain('Approval 7');
    expect(message).toMatch(/React 👍 to approve or 👎 to deny/);
  });

  // The row is what "approve <n>" resolves against, so the row's number is the one shown,
  // even if a registered display disagrees.
  it('shows the row\'s own number, not a disagreeing registered one', async () => {
    const { delivery, send, logger } = makeDelivery({ row: makeRow({ approvalNumber: 4 }), sendResult: { success: true } });
    delivery.registerDisplay('abcd1234', { preamble: 'p', payload: {}, approvalNumber: 9 });

    await delivery.deliver('abcd1234', 'email');

    const body = send.mock.calls[0]![0].body as string;
    expect(body.split('\n')).toContain('Approval 4');
    expect(body).not.toContain('Approval 9');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ rowNumber: 4, displayNumber: 9 }), expect.any(String));
  });

  // A pre-098 row has no number; a stale display number must not be shown for it either.
  it('falls back to the reference for an unnumbered row, even when the display carries a number', async () => {
    const { delivery, send } = makeDelivery({ sendResult: { success: true } });
    delivery.registerDisplay('abcd1234', { preamble: 'p', payload: {}, approvalNumber: 5 });

    await delivery.deliver('abcd1234', 'email');

    const body = send.mock.calls[0]![0].body as string;
    expect(body).toContain('Reference: abcd1234');
    expect(body).not.toContain('Approval 5');
    expect(body).toMatch(/Reply approve or deny, with the reference\./);
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

  it('stops offering channels that already failed for this approval, and logs at error when none remain', async () => {
    const { delivery, logger } = makeDelivery({
      identities: [identity('signal', '+15550001111'), identity('slack', 'U123')],
      principalEmail: '',
      sendResult: { success: false, blockedReason: 'down' },
    });

    const first = await delivery.deliver('abcd1234', 'signal');
    const second = await delivery.deliver('abcd1234', 'slack');

    expect(first).toMatchObject({ reason: 'send_failed', available: ['slack'] });
    expect(second).toMatchObject({ reason: 'send_failed', available: [] });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ shortRef: 'abcd1234' }), expect.stringContaining('every channel'));
  });
});

// GHSA-p49r-jqh2-v668: an approval raised on a turn that only claims to be the principal (an SMS,
// or email failing sender checks) goes only where the principal is proven, and a spoofer cannot
// flood those channels.
describe('ApprovalDelivery — unverified requests', () => {
  const unverified = makeRow({ requesterUnverified: true });

  it('refuses email for an unverified request, naming the verified channels left', async () => {
    const { delivery, send } = makeDelivery({ row: unverified, webReachable: () => true });
    await expect(delivery.deliver('abcd1234', 'email')).resolves.toEqual({
      delivered: false, reason: 'verified_channel_required', available: ['signal', 'web', 'slack'],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('delivers an unverified request on Signal, saying it could not be verified', async () => {
    const { delivery, send } = makeDelivery({ row: unverified });
    await expect(delivery.deliver('abcd1234', 'signal')).resolves.toEqual({ delivered: true, channel: 'signal' });
    expect(send.mock.calls[0]![0].message).toContain("can't prove you sent it");
  });

  it('holds a 4th unverified request in an hour for the digest, with one notice per window', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-17T12:00:00Z') });
    try {
      const { delivery, send, repo } = makeDelivery({ row: unverified });
      for (let i = 0; i < 3; i++) await expect(delivery.deliver('abcd1234', 'signal')).resolves.toMatchObject({ delivered: true });
      expect(send).toHaveBeenCalledTimes(3);

      await expect(delivery.deliver('abcd1234', 'signal')).resolves.toEqual({ delivered: false, reason: 'rate_limited', available: [] });
      expect(repo.claimNotification).toHaveBeenCalledTimes(3);
      expect(send).toHaveBeenCalledTimes(4);
      expect(send.mock.calls[3]![0]).toMatchObject({ channel: 'signal', recipient: '+15550001111' });
      expect(send.mock.calls[3]![0].message).toContain('waiting');

      await expect(delivery.deliver('abcd1234', 'signal')).resolves.toMatchObject({ reason: 'rate_limited' });
      expect(send).toHaveBeenCalledTimes(4);

      // An hour after the first, the window has room again.
      vi.advanceTimersByTime(60 * 60 * 1000 + 1);
      await expect(delivery.deliver('abcd1234', 'signal')).resolves.toMatchObject({ delivered: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts redeliveries against the same cap', async () => {
    const { delivery } = makeDelivery({ row: makeRow({ notificationSentAt: new Date(), approvalNumber: 3 }) });
    for (let i = 0; i < 3; i++) await expect(delivery.redeliverForVerification('3', 'sms')).resolves.toMatchObject({ delivered: true });
    await expect(delivery.redeliverForVerification('3', 'sms')).resolves.toMatchObject({ delivered: false, reason: 'rate_limited' });
  });

  it('never caps a request that did not come from an unverified channel', async () => {
    const { delivery } = makeDelivery();
    for (let i = 0; i < 5; i++) await expect(delivery.deliver('abcd1234', 'email')).resolves.toEqual({ delivered: true, channel: 'email' });
  });

  describe('redeliverForVerification', () => {
    it('re-sends an already delivered approval on the first verified channel, with the warning', async () => {
      const { delivery, send, repo } = makeDelivery({ row: makeRow({ notificationSentAt: new Date(), approvalNumber: 3 }) });
      await expect(delivery.redeliverForVerification('abcd1234', 'sms')).resolves.toEqual({ delivered: true, channel: 'signal' });
      expect(repo.claimNotification).not.toHaveBeenCalled();
      expect(send.mock.calls[0]![0].message).toContain('Someone answered approval 3 from your SMS number, which can\'t be verified.');
    });

    it('resolves the reference as approve-action does', async () => {
      const { delivery, repo } = makeDelivery({ row: makeRow({ notificationSentAt: new Date(), approvalNumber: 3 }) });
      await delivery.redeliverForVerification('3', 'email');
      expect(repo.resolvePending).toHaveBeenCalledWith('3');
    });

    it('takes the sole pending approval when the answer named none', async () => {
      const { delivery, repo, send } = makeDelivery({ row: makeRow({ notificationSentAt: new Date(), approvalNumber: 3 }) });
      await expect(delivery.redeliverForVerification('', 'sms')).resolves.toEqual({ delivered: true, channel: 'signal' });
      expect(repo.resolvePending).toHaveBeenCalledWith(undefined);
      expect(send.mock.calls[0]![0].message).toContain('approval 3');
    });

    it('reports several pending approvals as ambiguous, not as none', async () => {
      const pending = [makeRow({ approvalNumber: 3 }), makeRow({ id: 43, approvalNumber: 4 })];
      const { delivery, send } = makeDelivery({ resolve: { found: false, reason: 'ambiguous', error: 'Multiple pending requests', pending } });
      await expect(delivery.redeliverForVerification('', 'sms')).resolves.toMatchObject({ delivered: false, reason: 'ambiguous' });
      expect(send).not.toHaveBeenCalled();
    });

    // An approval not yet delivered (held by the cap, or not sent yet) is claimed, so it counts as
    // delivered: approve-action takes it, and the safety net does not send it a second time.
    it('claims an undelivered approval before re-sending it', async () => {
      const { delivery, repo, send } = makeDelivery({ row: makeRow({ requesterUnverified: true, approvalNumber: 3 }) });
      await expect(delivery.redeliverForVerification('3', 'sms')).resolves.toEqual({ delivered: true, channel: 'signal' });
      expect(repo.claimNotification).toHaveBeenCalledWith(42);
      expect(repo.claimNotification.mock.invocationCallOrder[0]!).toBeLessThan(send.mock.invocationCallOrder[0]!);
    });

    it('gives the claim and the hourly slot back when the re-send throws', async () => {
      const { delivery, repo } = makeDelivery({ row: makeRow({ approvalNumber: 3 }), sendThrows: true });
      for (let i = 0; i < 4; i++) {
        await expect(delivery.redeliverForVerification('3', 'sms')).resolves.toMatchObject({ delivered: false, reason: 'send_failed' });
      }
      expect(repo.releaseNotification).toHaveBeenCalledTimes(4);
    });

    it('reports no verified channel when the principal has none', async () => {
      const { delivery, send } = makeDelivery({ identities: [identity('email', 'principal@example.com')] });
      await expect(delivery.redeliverForVerification('abcd1234', 'email')).resolves.toEqual({
        delivered: false, reason: 'verified_channel_required', available: [],
      });
      expect(send).not.toHaveBeenCalled();
    });

    it('reports a resolved or unknown approval as not found', async () => {
      const { delivery } = makeDelivery({ row: null });
      await expect(delivery.redeliverForVerification('zz', 'sms')).resolves.toMatchObject({ delivered: false, reason: 'not_found' });
    });
  });
});
