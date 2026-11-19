import { describe, it, expect, vi } from 'vitest';
import { DeliverApprovalHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { ApprovalDelivery, DeliverResult } from '../../../../src/autonomy/approval-delivery.js';
import { createSilentLogger } from '../../../../src/logger.js';

function makeCtx(input: Record<string, unknown>, result?: DeliverResult, throws = false): ToolContext {
  const deliver = throws ? vi.fn().mockRejectedValue(new Error('boom')) : vi.fn().mockResolvedValue(result);
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: createSilentLogger(),
    approvalDelivery: { deliver } as unknown as ApprovalDelivery,
  } as unknown as ToolContext;
}

const handler = new DeliverApprovalHandler();

describe('DeliverApprovalHandler', () => {
  it('delivers on the chosen channel', async () => {
    const ctx = makeCtx({ short_ref: 'abcd1234', channel: 'signal' }, { delivered: true, channel: 'signal' });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.approvalDelivery!.deliver).toHaveBeenCalledWith('abcd1234', 'signal');
  });

  it('names the channels still available when a send fails, so the agent tries the next', async () => {
    const result = await handler.execute(makeCtx(
      { short_ref: 'abcd1234', channel: 'signal' },
      { delivered: false, reason: 'send_failed', available: ['slack', 'email'] },
    ));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toBe('Signal delivery failed. Channels still available: slack, email.');
  });

  // GHSA-p49r-jqh2-v668: SMS cannot carry an approval, and an unverified request goes only to a
  // verified channel, at most a few an hour.
  it('refuses sms as a channel', async () => {
    const ctx = makeCtx({ short_ref: 'abcd1234', channel: 'sms' }, { delivered: true, channel: 'signal' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toBe('channel must be one of: signal, web, slack, email');
    expect(ctx.approvalDelivery!.deliver).not.toHaveBeenCalled();
  });

  it('names the verified channels when an unverified request asks for email', async () => {
    const result = await handler.execute(makeCtx(
      { short_ref: 'abcd1234', channel: 'email' },
      { delivered: false, reason: 'verified_channel_required', available: ['signal', 'slack'] },
    ));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toBe(
      'This request came from a channel that cannot prove it was the principal, so it goes only to a verified channel. Channels available: signal, slack.',
    );
  });

  it('says a rate-limited approval waits in the digest and must not be retried', async () => {
    const result = await handler.execute(makeCtx(
      { short_ref: 'abcd1234', channel: 'signal' },
      { delivered: false, reason: 'rate_limited', available: [] },
    ));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toBe(
      'Too many unverified requests this hour, so approval abcd1234 waits in the console and the next digest. Do not try another channel. Tell the requester it is waiting for the principal.',
    );
  });

  it('says to stop when it was already delivered — one ping per approval', async () => {
    const result = await handler.execute(makeCtx(
      { short_ref: 'abcd1234', channel: 'email' },
      { delivered: false, reason: 'already_delivered', available: ['email'] },
    ));

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/already delivered.*do not send it again/i);
  });

  it('explains an unavailable channel and an unknown reference', async () => {
    const unavailable = await handler.execute(makeCtx(
      { short_ref: 'abcd1234', channel: 'slack' },
      { delivered: false, reason: 'channel_unavailable', available: ['email'] },
    ));
    expect((unavailable as { error: string }).error).toBe('The principal has no verified Slack identity. Channels available: email.');

    const unknown = await handler.execute(makeCtx(
      { short_ref: 'zzzz0000', channel: 'email' },
      { delivered: false, reason: 'not_found', available: ['email'] },
    ));
    expect((unknown as { error: string }).error).toMatch(/no pending approval.*zzzz0000/i);
  });

  it('validates its inputs and capability, and never throws', async () => {
    expect((await handler.execute(makeCtx({ channel: 'signal' }))).success).toBe(false);
    expect((await handler.execute(makeCtx({ short_ref: 'abcd1234', channel: 'pigeon' }))).success).toBe(false);
    expect((await handler.execute({ ...makeCtx({ short_ref: 'a', channel: 'email' }), approvalDelivery: undefined } as ToolContext)).success).toBe(false);
    expect((await handler.execute(makeCtx({ short_ref: 'abcd1234', channel: 'email' }, undefined, true))).success).toBe(false);
  });
});
