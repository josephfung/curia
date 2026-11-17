import { describe, it, expect, vi } from 'vitest';
import { BATCH_CONFIRMED_TOO_SOON, BATCH_READ_BACK_FIRST, CeoInboxSendDraftHandler, SEND_DEADLINE_RESERVE_MS, SEND_OUTCOME_UNKNOWN } from './handler.js';
import { stubPrincipalMailboxes } from '../../../_shared/principal-mailboxes-test-helpers.js';
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
    // A deliberate rule, so a policy hold (#2587).
    expect(result).toEqual({ success: false, error: PRINCIPAL_SEND_REFUSALS.approval_replay, errorType: 'POLICY_HOLD' });
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

  // #2587: the console tells a guard's call from a failure by errorType alone.
  it('carries a policy hold through as errorType POLICY_HOLD', async () => {
    const { gateway } = gatewayReturning({
      success: false, leftAsDraft: true, refusal: 'recipient_not_on_thread', blockedReason: PRINCIPAL_SEND_REFUSALS.recipient_not_on_thread, policyHold: true,
    });
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway }));
    expect(result).toEqual({ success: false, error: PRINCIPAL_SEND_REFUSALS.recipient_not_on_thread, errorType: 'POLICY_HOLD' });
  });

  it('leaves a failure without a policy hold untyped, so it still counts as a hiccup', async () => {
    const { gateway } = gatewayReturning({
      success: false, leftAsDraft: true, refusal: 'lookup_failed', blockedReason: PRINCIPAL_SEND_REFUSALS.lookup_failed,
    });
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway }));
    expect(result).toEqual({ success: false, error: PRINCIPAL_SEND_REFUSALS.lookup_failed });
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

describe('CeoInboxSendDraftHandler — mailbox input (#2475)', () => {
  it('refuses an unknown mailbox id without calling the gateway', async () => {
    const { gateway, sendPrincipalDraft } = gatewayReturning({ success: true });
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx({
      outboundGateway: gateway,
      input: { draft_id: 'draft-1', mailbox: 'nope' },
      principalMailboxes: stubPrincipalMailboxes({}),
    }));
    expect(result.success).toBe(false);
    expect(sendPrincipalDraft).not.toHaveBeenCalled();
  });

  it('passes a valid mailbox to the gateway, and none when omitted', async () => {
    const { gateway, sendPrincipalDraft } = gatewayReturning({ success: true, messageId: 'm-1', to: [], subject: 's' });
    await new CeoInboxSendDraftHandler().execute(buildCtx({
      outboundGateway: gateway,
      input: { draft_id: 'draft-1', mailbox: 'work' },
      principalMailboxes: stubPrincipalMailboxes({}),
    }));
    expect(sendPrincipalDraft.mock.calls[0]![1]).toMatchObject({ mailbox: 'work' });
  });
});

describe('CeoInboxSendDraftHandler — limit cue (#2475 R47)', () => {
  it.each([
    ['daily_cap', true], ['thread_cooldown', true], ['mailing_list', false], ['lookup_failed', false],
  ] as const)('the model sees "Waiting (limit)" only for a limit: %s', async (refusal, isLimit) => {
    const { gateway } = gatewayReturning({ success: false, leftAsDraft: true, refusal, blockedReason: PRINCIPAL_SEND_REFUSALS[refusal] });
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway }));
    // Only the error text reaches the model: no structured failure data (the ToolResult change was reverted).
    expect(result).toEqual({ success: false, error: PRINCIPAL_SEND_REFUSALS[refusal] });
    expect(PRINCIPAL_SEND_REFUSALS[refusal].startsWith('Waiting (limit): ')).toBe(isLimit);
  });

  it('a thread cooldown never reads as held', () => {
    expect(PRINCIPAL_SEND_REFUSALS.thread_cooldown).not.toMatch(/held/i);
  });
});

// #2474 design D6: "send yesterday morning's drafts" is read back before anything goes out. The
// rule used to live only in the description, and a coordinator brief saying "send them" beat it.
describe('CeoInboxSendDraftHandler — batch read-back (#2474 D6)', () => {
  const sentOk: PrincipalDraftSendResult = { success: true, messageId: 'm-1', to: ['a@example.com'], subject: 'Hi' };
  const refused = { success: false, error: BATCH_READ_BACK_FIRST, errorType: 'POLICY_HOLD' };
  // A draft already went out in this turn: the refusal says so, so the agent reports the partial send.
  const refusedAfterOne = { success: false, error: expect.stringMatching(/^Not sent: one draft has already gone out/), errorType: 'POLICY_HOLD' };
  // Two specialist tasks the coordinator started for the same principal message share its task id.
  const delegatedFrom = (coordinatorTask: string) => ({ ...principalMetadata, delegationOrigin: { taskEventId: coordinatorTask } });

  it('refuses an unconfirmed send declared as one of a batch, without calling the gateway', async () => {
    const { gateway, sendPrincipalDraft } = gatewayReturning(sentOk);
    const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway, input: { draft_id: 'draft-1', batch_size: 2 } }));
    expect(result).toEqual(refused);
    expect(sendPrincipalDraft).not.toHaveBeenCalled();
  });

  it('sends a single draft in one turn, declared or not (46d/46f)', async () => {
    for (const input of [{ draft_id: 'draft-1' }, { draft_id: 'draft-1', batch_size: 1 }]) {
      const { gateway, sendPrincipalDraft } = gatewayReturning(sentOk);
      const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway, input }));
      expect(result.success).toBe(true);
      expect(sendPrincipalDraft).toHaveBeenCalledOnce();
    }
  });

  it('sends every draft of a confirmed batch, one call each (30w, the turn after the read-back)', async () => {
    const { gateway, sendPrincipalDraft } = gatewayReturning(sentOk);
    const handler = new CeoInboxSendDraftHandler();
    for (const id of ['draft-1', 'draft-2', 'draft-3']) {
      const result = await handler.execute(buildCtx({ outboundGateway: gateway, input: { draft_id: id, batch_size: 3, batch_confirmed: true } }));
      expect(result.success).toBe(true);
    }
    expect(sendPrincipalDraft.mock.calls.map((c) => c[0])).toEqual(['draft-1', 'draft-2', 'draft-3']);
  });

  it('refuses a second, different draft in the same turn when the model called neither a batch', async () => {
    const { gateway, sendPrincipalDraft } = gatewayReturning(sentOk);
    const handler = new CeoInboxSendDraftHandler();
    expect((await handler.execute(buildCtx({ outboundGateway: gateway, input: { draft_id: 'draft-1' } }))).success).toBe(true);
    expect(await handler.execute(buildCtx({ outboundGateway: gateway, input: { draft_id: 'draft-2' } }))).toEqual(refusedAfterOne);
    expect(sendPrincipalDraft).toHaveBeenCalledOnce();
  });

  it('keeps refusing in a turn once a read-back was asked, even if the model re-calls it a single', async () => {
    const { gateway, sendPrincipalDraft } = gatewayReturning(sentOk);
    const handler = new CeoInboxSendDraftHandler();
    await handler.execute(buildCtx({ outboundGateway: gateway, taskEventId: 'spec-1', taskMetadata: delegatedFrom('coord-1'), input: { draft_id: 'draft-1', batch_size: 2 } }));
    // A re-delegation in the same principal turn is a new specialist task under the same coordinator task.
    const again = await handler.execute(buildCtx({ outboundGateway: gateway, taskEventId: 'spec-2', taskMetadata: delegatedFrom('coord-1'), input: { draft_id: 'draft-1' } }));
    expect(again).toEqual(refused);
    expect(sendPrincipalDraft).not.toHaveBeenCalled();
    // The principal's next message is a new coordinator task: a confirmed send goes through.
    const next = await handler.execute(buildCtx({ outboundGateway: gateway, taskEventId: 'spec-3', taskMetadata: delegatedFrom('coord-2'), input: { draft_id: 'draft-1', batch_size: 2, batch_confirmed: true } }));
    expect(next.success).toBe(true);
  });

  it('counts an unknown outcome as sent for the turn', async () => {
    const sendPrincipalDraft = vi.fn(async () => { throw new Error('socket hang up'); });
    const gateway = { sendPrincipalDraft } as unknown as OutboundGateway;
    const handler = new CeoInboxSendDraftHandler();
    await handler.execute(buildCtx({ outboundGateway: gateway, input: { draft_id: 'draft-1' } }));
    expect(await handler.execute(buildCtx({ outboundGateway: gateway, input: { draft_id: 'draft-2' } }))).toEqual(refusedAfterOne);
  });

  // The refusal names batch_confirmed, so a model could retry with it at once. The principal's yes
  // only arrives in a later message, so a confirmation in the refusing turn is refused too.
  it('refuses batch_confirmed claimed in the same turn the read-back was asked', async () => {
    const { gateway, sendPrincipalDraft } = gatewayReturning(sentOk);
    const handler = new CeoInboxSendDraftHandler();
    expect(await handler.execute(buildCtx({ outboundGateway: gateway, input: { draft_id: 'draft-1', batch_size: 2 } }))).toEqual(refused);
    expect(await handler.execute(buildCtx({ outboundGateway: gateway, input: { draft_id: 'draft-1', batch_size: 2, batch_confirmed: true } })))
      .toEqual({ success: false, error: BATCH_CONFIRMED_TOO_SOON, errorType: 'POLICY_HOLD' });
    expect(sendPrincipalDraft).not.toHaveBeenCalled();
  });

  it('leaves sends that are not principal-directed to the gateway (triage)', async () => {
    const { gateway, sendPrincipalDraft } = gatewayReturning(sentOk);
    const handler = new CeoInboxSendDraftHandler();
    for (const id of ['draft-1', 'draft-2']) {
      await handler.execute(buildCtx({ outboundGateway: gateway, liveTurn: false, input: { draft_id: id } }));
    }
    expect(sendPrincipalDraft).toHaveBeenCalledTimes(2);
  });

  it('rejects a batch_size that is not a whole number of 1 or more', async () => {
    const { gateway, sendPrincipalDraft } = gatewayReturning(sentOk);
    for (const batch_size of [0, 1.5, 'two']) {
      const result = await new CeoInboxSendDraftHandler().execute(buildCtx({ outboundGateway: gateway, input: { draft_id: 'draft-1', batch_size } }));
      expect(result.success).toBe(false);
    }
    expect(sendPrincipalDraft).not.toHaveBeenCalled();
  });
});
