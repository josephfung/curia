// handler.test.ts — card-use-confirm (#1358). It runs only as an approval replay. The service
// is real; its repo and bus are stubs.

import { describe, it, expect, vi } from 'vitest';
import { CardUseConfirmHandler, CARD_USE_CONFIRM_REFUSAL } from './handler.js';
import { CardUseService, CARD_USE_CONTINUE_MESSAGE } from '../../../../src/secrets/card-use-service.js';
import type { CardUseRepo, CardUseRequestRow } from '../../../../src/secrets/card-use-repo.js';
import type { ApprovalVia, ToolContext } from '../../../../src/skills/types.js';
import { createSilentLogger } from '../../../../src/logger.js';

const ROW: CardUseRequestRow = {
  id: 'req-1',
  secretName: 'user.visa',
  siteDomain: 'aircanada.com',
  conversationId: 'conv-1',
  taskId: 'task-1',
  amount: 'CA$412.30',
  purpose: 'Air Canada YYZ-SFO, Dec 12',
  origin: { conversationId: 'conv-1', channelId: 'signal', agentId: 'coordinator', resumeIntent: 'Continue the purchase' },
  status: 'pending',
  approvalShortRef: 'abcd1234',
  createdAt: new Date(),
  approvedAt: null,
};

function setup(approveResult: 'approved' | 'expired' | 'already_resolved' = 'approved') {
  const approve = vi.fn().mockResolvedValue(approveResult);
  const get = vi.fn().mockResolvedValue(ROW);
  const publish = vi.fn().mockResolvedValue(undefined);
  const service = new CardUseService({
    repo: { approve, get } as unknown as CardUseRepo,
    secrets: { getCardPublic: vi.fn() },
    approvalTrigger: { request: vi.fn() },
    bus: { publish },
    logger: createSilentLogger(),
  });
  const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
    input: { request_id: 'req-1' },
    log: createSilentLogger(),
    cardUse: service,
    humanApproved: true,
    ...overrides,
  }) as unknown as ToolContext;
  const run = (via: ApprovalVia | undefined, conversationId: string | undefined) =>
    new CardUseConfirmHandler().execute(ctx({ approvalVia: via, conversationId }));
  return { approve, publish, ctx, run };
}

const decided = (publish: ReturnType<typeof vi.fn>) =>
  publish.mock.calls.map((c) => c[1]).filter((e) => e.type === 'card_use.decided');

describe('card-use-confirm', () => {
  it('refuses without humanApproved and writes nothing', async () => {
    const { approve, publish, ctx } = setup();
    const result = await new CardUseConfirmHandler().execute(ctx({ humanApproved: undefined }));
    expect(result).toEqual({ success: false, error: CARD_USE_CONFIRM_REFUSAL });
    expect(approve).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses humanApproved: false', async () => {
    const { approve, ctx } = setup();
    const result = await new CardUseConfirmHandler().execute(ctx({ humanApproved: false }));
    expect(result.success).toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  it('approve via coordinator in originating conversation: grant, no resume', async () => {
    const { approve, publish, run } = setup();
    const result = await run('coordinator', 'conv-1');
    expect(approve).toHaveBeenCalledWith('req-1');
    expect(result).toEqual({
      success: true,
      data: { outcome: 'approved', resumed: false, message: CARD_USE_CONTINUE_MESSAGE },
    });
    // The decision is recorded for the audit trail, but it asks for no resume.
    expect(decided(publish)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ decision: 'approved', via: 'coordinator', resume: false }) }),
    ]);
  });

  it('approve via coordinator from another conversation resumes the originator', async () => {
    const { publish, run } = setup();
    const result = await run('coordinator', 'conv-other');
    expect((result as { data: { resumed: boolean } }).data.resumed).toBe(true);
    expect(decided(publish)[0].payload.resume).toBe(true);
  });

  it('approve via reaction: grant and card_use.decided resume published', async () => {
    const { approve, publish, run } = setup();
    const result = await run('reaction', 'conv-1');
    expect(approve).toHaveBeenCalledWith('req-1');
    expect((result as { data: { outcome: string; resumed: boolean } }).data).toMatchObject({ outcome: 'approved', resumed: true });
    const [layer, event] = publish.mock.calls[0]!;
    expect(layer).toBe('execution');
    expect(event.type).toBe('card_use.decided');
    expect(event.payload).toEqual({
      requestId: 'req-1',
      secretName: 'user.visa',
      siteDomain: 'aircanada.com',
      decision: 'approved',
      via: 'reaction',
      resume: true,
      origin: ROW.origin,
      purpose: ROW.purpose,
    });
  });

  it('approve via console resumes the originator too', async () => {
    const { publish, run } = setup();
    await run('console', 'conv-1');
    expect(decided(publish)[0].payload).toMatchObject({ via: 'console', resume: true });
  });

  it('late approval writes no grant: the result says it expired and the resume says expired', async () => {
    const { publish, run } = setup('expired');
    const result = await run('reaction', 'conv-1');
    const data = (result as { data: { outcome: string; message: string } }).data;
    expect(data.outcome).toBe('expired');
    expect(data.message).toMatch(/no grant was written/);
    expect(decided(publish)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ decision: 'expired', resume: true }) }),
    ]);
  });

  it('second approval is a no-op', async () => {
    const { publish, run } = setup('already_resolved');
    const result = await run('reaction', 'conv-1');
    expect((result as { data: { outcome: string; resumed: boolean } }).data).toMatchObject({ outcome: 'already_resolved', resumed: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it('still reports the approval when the resume cannot be published', async () => {
    const { publish, run } = setup();
    publish.mockRejectedValue(new Error('bus down'));
    const result = await run('reaction', 'conv-1');
    expect((result as { data: { outcome: string; resumed: boolean } }).data).toMatchObject({ outcome: 'approved', resumed: false });
  });

  it('errors on an unknown request', async () => {
    const { ctx } = setup();
    const svc = { confirm: vi.fn().mockRejectedValue(new Error('Unknown card-use request.')) };
    const result = await new CardUseConfirmHandler().execute(ctx({ cardUse: svc as unknown as ToolContext['cardUse'] }));
    expect(result).toEqual({ success: false, error: 'Unknown card-use request.' });
  });
});
