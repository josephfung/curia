// handler.test.ts — card-use-request (#1358). The service is real; its repo, vault, approval
// trigger and bus are stubs, so these tests see exactly what reaches the principal.

import { describe, it, expect, vi } from 'vitest';
import { CardUseRequestHandler } from './handler.js';
import { CardUseService } from '../../../../src/secrets/card-use-service.js';
import type { CardUseRepo } from '../../../../src/secrets/card-use-repo.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { createSilentLogger } from '../../../../src/logger.js';

const CARD_NUMBER = '4111111111111111';

function setup(opts: { card?: boolean } = {}) {
  const create = vi.fn().mockResolvedValue({ id: 'req-1', siteDomain: 'aircanada.com' });
  const setShortRef = vi.fn().mockResolvedValue(undefined);
  const request = vi.fn().mockResolvedValue({ created: true, shortRef: 'abcd1234', approvalNumber: 4 });
  const publish = vi.fn().mockResolvedValue(undefined);
  const getCardPublic = vi.fn().mockResolvedValue(
    opts.card === false
      ? null
      : {
          label: 'Personal',
          publicFields: { brand: 'visa', last4: '1111', expiry_month: '04', expiry_year: '2030', cardholder_name: 'A B' },
        },
  );
  const service = new CardUseService({
    repo: { create, setShortRef } as unknown as CardUseRepo,
    secrets: { getCardPublic },
    approvalTrigger: { request },
    bus: { publish },
    logger: createSilentLogger(),
  });
  const ctx = (input: Record<string, unknown>): ToolContext => ({
    input,
    log: createSilentLogger(),
    cardUse: service,
    taskEventId: 'task-1',
    conversationId: 'conv-1',
    channelId: 'signal',
    agentId: 'coordinator',
    timezone: 'America/Toronto',
  }) as unknown as ToolContext;
  return { create, setShortRef, request, publish, ctx };
}

const GOOD_INPUT = {
  secret_name: 'user.visa',
  site_url: 'https://www.aircanada.com/checkout',
  amount: 'CA$412.30',
  purpose: 'Air Canada YYZ-SFO, Dec 12',
};

describe('card-use-request', () => {
  it('on a non-card key errors and files nothing', async () => {
    const { ctx, create, request } = setup({ card: false });
    const result = await new CardUseRequestHandler().execute(ctx({ ...GOOD_INPUT, secret_name: 'user.aeroplan_password' }));
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('not a saved card');
    expect(create).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('files a 30-minute critical approval for card-use-confirm whose display has no number', async () => {
    const { ctx, create, request, setShortRef } = setup();
    const result = await new CardUseRequestHandler().execute(ctx(GOOD_INPUT));

    expect(result.success).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      secretName: 'user.visa', siteUrl: 'https://www.aircanada.com/checkout', conversationId: 'conv-1', taskId: 'task-1',
    }));
    const filed = request.mock.calls[0]![0] as Record<string, unknown>;
    expect(filed).toMatchObject({
      toolName: 'card-use-confirm',
      input: { request_id: 'req-1' },
      actionRisk: 'critical',
      expiresInMs: 30 * 60_000,
      taskId: 'task-1',
      conversationId: 'conv-1',
    });
    const display = JSON.stringify(filed['displayInput']);
    expect(display).toContain('••1111');
    expect(display).not.toContain(CARD_NUMBER);
    expect(JSON.stringify(filed)).not.toContain(CARD_NUMBER);
    expect(filed['reason']).toBe(
      'Curia wants to pay CA$412.30 at aircanada.com with Visa ••1111 (Personal) for: Air Canada YYZ-SFO, Dec 12. The amount is what Curia read on the page.',
    );
    expect(setShortRef).toHaveBeenCalledWith('req-1', 'abcd1234');
  });

  it('returns the approval ref, number, local expiry and masked card', async () => {
    const { ctx } = setup();
    const result = await new CardUseRequestHandler().execute(ctx(GOOD_INPUT));
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ approval_ref: 'abcd1234', approval_number: 4, card: 'Visa ••1111 (Personal)' });
    // A local ISO stamp carries a numeric offset, not the Z suffix.
    expect(data['expires_at']).toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it('publishes card_use.requested with brand and last four, never the number', async () => {
    const { ctx, publish } = setup();
    await new CardUseRequestHandler().execute(ctx(GOOD_INPUT));
    const [layer, event] = publish.mock.calls[0]!;
    expect(layer).toBe('execution');
    expect(event.type).toBe('card_use.requested');
    expect(event.payload).toEqual({
      requestId: 'req-1', secretName: 'user.visa', siteDomain: 'aircanada.com', amount: 'CA$412.30',
      brand: 'visa', last4: '1111', label: 'Personal',
    });
  });

  it('rejects a missing input', async () => {
    const { ctx, create } = setup();
    const result = await new CardUseRequestHandler().execute(ctx({ ...GOOD_INPUT, amount: '  ' }));
    expect(result).toEqual({ success: false, error: 'amount is required and must be a non-empty string.' });
    expect(create).not.toHaveBeenCalled();
  });
});
