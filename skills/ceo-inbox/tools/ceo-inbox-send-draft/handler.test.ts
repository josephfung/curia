import { describe, it, expect, vi } from 'vitest';
import { CeoInboxSendDraftHandler, SEND_DEADLINE_RESERVE_MS, SEND_OUTCOME_UNKNOWN } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import {
  PRINCIPAL_SEND_REFUSALS,
  type OutboundGateway,
  type PrincipalDraftSendResult,
} from '../../../../src/skills/outbound-gateway.js';

const principalMetadata = {
  originator: { contactId: 'ceo-1', systemRole: 'principal', channel: 'signal', initiatedAt: '2026-11-07T12:00:00.000Z' },
};

function gatewayReturning(result: PrincipalDraftSendResult) {
  const sendPrincipalDraft = vi.fn(async (_draftId: string, _options: Record<string, unknown>) => result);
  return { gateway: { sendPrincipalDraft } as unknown as OutboundGateway, sendPrincipalDraft };
}

function buildCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    toolName: 'ceo-inbox-send-draft',
    toolVersion: '0.1.0',
    input: { draft_id: 'draft-1' },
    timezone: 'America/Toronto',
    secret: () => { throw new Error('no secrets'); },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    liveTurn: true,
    taskMetadata: principalMetadata,
    taskEventId: 'task-1',
    conversationId: 'conv-1',
    ...overrides,
  } as unknown as ToolContext;
}

describe('CeoInboxSendDraftHandler', () => {
  it('fails without the outbound gateway', async () => {
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx());
    expect(result).toEqual({ success: false, error: 'ceo-inbox-send-draft requires outboundGateway' });
  });

  it('rejects a missing or blank draft_id', async () => {
    const { gateway, sendPrincipalDraft } = gatewayReturning({ success: true });
    for (const input of [{}, { draft_id: '   ' }, { draft_id: 42 }]) {
      const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway, input }));
      expect(result).toEqual({ success: false, error: 'Missing required input: draft_id (string)' });
    }
    expect(sendPrincipalDraft).not.toHaveBeenCalled();
  });

  it('rejects an approval replay without calling the gateway', async () => {
    const { gateway, sendPrincipalDraft } = gatewayReturning({ success: true });
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway, humanApproved: true }));
    expect(result).toEqual({ success: false, error: PRINCIPAL_SEND_REFUSALS.approval_replay });
    expect(sendPrincipalDraft).not.toHaveBeenCalled();
  });

  it('passes liveTurn and taskMetadata through as authority', async () => {
    const { gateway, sendPrincipalDraft } = gatewayReturning({ success: true, messageId: 'm-1', to: ['a@example.com'], subject: 'Hi' });
    await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway, input: { draft_id: '  draft-1  ' } }));
    expect(sendPrincipalDraft).toHaveBeenCalledWith('draft-1', {
      authority: { liveTurn: true, taskMetadata: principalMetadata, humanApproved: undefined },
      taskEventId: 'task-1',
      conversationId: 'conv-1',
    });
  });

  it('returns message_id, to and subject on success', async () => {
    const { gateway } = gatewayReturning({ success: true, messageId: 'm-1', to: ['a@example.com', 'b@example.com'], subject: 'Re: Plans' });
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway }));
    expect(result).toEqual({
      success: true,
      data: { message_id: 'm-1', to: ['a@example.com', 'b@example.com'], subject: 'Re: Plans' },
    });
  });

  it("returns the gateway's refusal text as the error", async () => {
    const { gateway } = gatewayReturning({
      success: false, leftAsDraft: true, refusal: 'not_requested', blockedReason: PRINCIPAL_SEND_REFUSALS.not_requested,
    });
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway }));
    expect(result).toEqual({ success: false, error: PRINCIPAL_SEND_REFUSALS.not_requested });
  });

  it('returns a check failure that carries no refusal code', async () => {
    // A blocked contact, content filter or bounce leaves the draft with a reason and no code.
    const { gateway } = gatewayReturning({ success: false, leftAsDraft: true, blockedReason: 'Recipient is blocked.' });
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway }));
    expect(result).toEqual({ success: false, error: 'Recipient is blocked.' });
  });

  it('reports not_found without retry', async () => {
    const { gateway, sendPrincipalDraft } = gatewayReturning({
      success: false, leftAsDraft: true, refusal: 'not_found', blockedReason: PRINCIPAL_SEND_REFUSALS.not_found,
    });
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway }));
    expect(result).toEqual({ success: false, error: PRINCIPAL_SEND_REFUSALS.not_found });
    expect(sendPrincipalDraft).toHaveBeenCalledOnce();
  });

  it('reports an unknown outcome, not a refusal, when the send is still running at the deadline', async () => {
    vi.useFakeTimers();
    try {
      let finish: (r: PrincipalDraftSendResult) => void = () => {};
      const sendPrincipalDraft = vi.fn(() => new Promise<PrincipalDraftSendResult>((resolve) => { finish = resolve; }));
      const gateway = { sendPrincipalDraft } as unknown as OutboundGateway;
      const ctx = buildCtx({ outboundGateway: gateway, deadline: Date.now() + 30_000 });
      const pending = new CeoInboxSendDraftHandler().execute(ctx);
      // Answers before the execution layer's own timeout would.
      await vi.advanceTimersByTimeAsync(30_000 - SEND_DEADLINE_RESERVE_MS);
      expect(await pending).toEqual({ success: false, error: SEND_OUTCOME_UNKNOWN });
      // The late outcome is logged, not lost.
      finish({ success: true, messageId: 'm-1' });
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.log.warn).toHaveBeenCalledWith(expect.objectContaining({ sent: true }), expect.stringMatching(/after the deadline/));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an unknown outcome when the deadline has already passed', async () => {
    vi.useFakeTimers();
    try {
      const sendPrincipalDraft = vi.fn(() => new Promise<PrincipalDraftSendResult>(() => {}));
      const gateway = { sendPrincipalDraft } as unknown as OutboundGateway;
      const pending = new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway, deadline: Date.now() - 5 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending).toEqual({ success: false, error: SEND_OUTCOME_UNKNOWN });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an unknown outcome, not the raw error, when the send throws', async () => {
    const sendPrincipalDraft = vi.fn(async () => { throw new Error('socket hang up'); });
    const gateway = { sendPrincipalDraft } as unknown as OutboundGateway;
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway, deadline: Date.now() + 30_000 }));
    expect(result).toEqual({ success: false, error: SEND_OUTCOME_UNKNOWN });
  });

  it('returns the result as usual when the send finishes before the deadline', async () => {
    const { gateway } = gatewayReturning({ success: true, messageId: 'm-1', to: ['a@example.com'], subject: 'Hi' });
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway, deadline: Date.now() + 30_000 }));
    expect(result).toEqual({ success: true, data: { message_id: 'm-1', to: ['a@example.com'], subject: 'Hi' } });
  });

  it('never reports success for a failure with no reason', async () => {
    const { gateway } = gatewayReturning({ success: false });
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not sent/i);
  });
});
