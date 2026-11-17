// handler.ts — ceo-inbox-send-draft: send one draft from the principal's own mailbox (#2474).
//
// Every decision lives in OutboundGateway.sendPrincipalDraft: the send setting, who is asking
// (live principal turn, not an approval replay), the draft's checks and the send itself. This
// handler only passes the call's authority through, unchanged, and relays the outcome. The
// authority fields come from the agent.task event, never from the model's input.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { checkMailboxInput, readMailboxInput } from '../../../_shared/principal-mailbox-client.js';
import { PRINCIPAL_SEND_REFUSALS, type PrincipalDraftSendResult } from '../../../../src/skills/outbound-gateway.js';
import { gatewaySendFailure } from '../../../../src/skills/_shared/policy-hold.js';
import { isPrincipalDirectedMailboxSend } from '../../../../src/skills/principal-send/authority.js';

/**
 * Returned when a principal-directed send is part of a batch the principal has not confirmed
 * (#2474, design D6). The read-back rule used to live only in the tool description, and a
 * coordinator brief saying "find them and send them" overrode it: ceo-inbox sent in turn 1 with
 * no read-back. So it is enforced here, and this text tells the model what to do instead.
 */
export const BATCH_READ_BACK_FIRST =
  "Not sent: two or more drafts in one request go out only after the principal confirms the set. This draft is still in Drafts. Send none of them now: reply with the count and each draft's recipient and subject, and ask \"send all, or go through them?\". When the principal says yes to that list in a later message, send each one with batch_confirmed: true. Being asked to send them is not that yes.";

/**
 * Returned when the model claims batch_confirmed in the same turn a read-back was demanded. The
 * principal's yes can only arrive in a later message (a new turn), so a same-turn confirmation is
 * the model lifting the guard itself, which is the D6 failure this guard exists to stop.
 */
export const BATCH_CONFIRMED_TOO_SOON =
  "Not sent: the principal hasn't answered the read-back yet. Their yes comes in a later message, not this turn. This draft is still in Drafts: reply with each draft's recipient and subject and ask \"send all, or go through them?\".";

/**
 * The refusal when a different draft already went out (or may have) in this turn: the model must
 * report that partial send, not "none of them went", so it names how many already left.
 */
function partialBatchRefusal(alreadySent: number): string {
  const which = alreadySent === 1 ? 'one draft has' : `${alreadySent} drafts have`;
  return `Not sent: ${which} already gone out in this request, and the rest wait until the principal confirms the set. Tell the principal what already went, then list the remaining drafts' recipients and subjects and ask "send the rest?". When they say yes in a later message, send each with batch_confirmed: true.`;
}

/** How long a turn's send record is kept: far longer than any one turn runs. */
const TURN_RECORD_TTL_MS = 60 * 60 * 1000;

/** What this process has seen of one principal turn's principal-directed sends. */
interface TurnSends {
  at: number;
  /** Drafts sent, or possibly sent (outcome unknown), in this turn. */
  sent: Set<string>;
  /** A batch read-back was demanded in this turn, so every unconfirmed send in it waits. */
  readBackAsked: boolean;
}

/**
 * The principal turn a call belongs to. One principal message starts one coordinator task, and
 * `delegate` stamps that task's id on the specialist's delegationOrigin, so every ceo-inbox task
 * the coordinator starts for that message shares it (a re-delegation in the same turn too). A
 * call with no delegation origin is its own task's turn.
 */
function turnKeyOf(ctx: ToolContext): string | undefined {
  const origin = ctx.taskMetadata?.['delegationOrigin'];
  if (origin && typeof origin === 'object') {
    const id = (origin as Record<string, unknown>)['taskEventId'];
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return ctx.taskEventId;
}

// Time kept back from the skill's deadline, so this handler answers before the execution
// layer's timeout does. That timeout's text reads like a refusal, but the send keeps running.
export const SEND_DEADLINE_RESERVE_MS = 1_000;

/**
 * Returned when the gateway call has not finished by the deadline or threw: the send's outcome
 * is unknown and it may still go out, so the agent must not report it either way or send again.
 */
export const SEND_OUTCOME_UNKNOWN =
  "The send didn't finish, so it may still go out. Don't send this draft again and don't report it as sent or as not sent; check the principal's Sent folder later.";

export class CeoInboxSendDraftHandler implements ToolHandler {
  // Per turn, in memory: the loader builds one handler per process, and a turn lasts minutes.
  // A restart forgets it, which can only make a later send in that turn ask again (fail toward asking).
  private readonly turns = new Map<string, TurnSends>();

  /** This turn's record, created on first use; stale turns are dropped on the way. */
  private turnSends(key: string): TurnSends {
    const now = Date.now();
    for (const [k, t] of this.turns) if (now - t.at > TURN_RECORD_TTL_MS) this.turns.delete(k);
    let turn = this.turns.get(key);
    if (!turn) {
      turn = { at: now, sent: new Set(), readBackAsked: false };
      this.turns.set(key, turn);
    }
    return turn;
  }

  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.outboundGateway) {
      return { success: false, error: 'ceo-inbox-send-draft requires outboundGateway' };
    }

    const rawDraftId = ctx.input?.['draft_id'];
    const draftId = typeof rawDraftId === 'string' ? rawDraftId.trim() : '';
    if (!draftId) return { success: false, error: 'Missing required input: draft_id (string)' };

    // The gateway locates the draft across every mailbox; a named one is the only one asked. A
    // given id must still be a live mailbox (an unknown or removed id is an error, never the default).
    const mailboxError = await checkMailboxInput(ctx, ctx.input, 'ceo-inbox-send-draft');
    if (mailboxError) return { success: false, error: mailboxError };
    const named = readMailboxInput(ctx.input);
    const mailbox = named.ok ? named.mailbox : undefined;

    // An approval replay is refused here as well as in the gateway (design D5): the execution
    // layer never queues this tool, so a replay can only be a stale or forged row.
    if (ctx.humanApproved === true) {
      ctx.log.warn({ draftId }, 'ceo-inbox-send-draft: approval replay refused');
      return { success: false, error: PRINCIPAL_SEND_REFUSALS.approval_replay, errorType: 'POLICY_HOLD' };
    }

    // Batch read-back (#2474, design D6). A principal-directed send that is one of two or more in
    // one request waits until the principal has confirmed the set. The model declares the batch
    // (batch_size) and the confirmation (batch_confirmed); the turn record backs that up: once a
    // read-back was demanded in this turn, or another draft already went out in it, an
    // unconfirmed send is refused even if the model now calls it a single. Triage's own sends are
    // not principal-directed and are untouched: they have their own limits in the gateway.
    const rawBatchSize = ctx.input?.['batch_size'];
    const batchSize = typeof rawBatchSize === 'string' && /^\d+$/.test(rawBatchSize.trim()) ? Number(rawBatchSize) : rawBatchSize;
    if (batchSize !== undefined && batchSize !== null && !(typeof batchSize === 'number' && Number.isInteger(batchSize) && batchSize >= 1)) {
      return { success: false, error: 'batch_size must be a whole number, 1 or more (omit it for a single draft)' };
    }
    const confirmed = ctx.input?.['batch_confirmed'] === true || ctx.input?.['batch_confirmed'] === 'true';
    const directed = isPrincipalDirectedMailboxSend({ liveTurn: ctx.liveTurn, taskMetadata: ctx.taskMetadata, humanApproved: ctx.humanApproved });
    const turnKey = directed ? turnKeyOf(ctx) : undefined;
    const turn = turnKey !== undefined ? this.turnSends(turnKey) : undefined;
    // Without a turn key only a declared batch_size is enforced; refusing every keyless send would
    // break single sends, so say so loudly instead of switching the turn checks off unseen.
    if (directed && turnKey === undefined) {
      ctx.log.warn({ draftId }, 'ceo-inbox-send-draft: no turn key on a principal-directed send — batch turn checks are off for it');
    }
    // A confirmation claimed in the turn that demanded the read-back cannot be the principal's.
    if (directed && confirmed && turn?.readBackAsked === true) {
      ctx.log.warn({ draftId }, 'ceo-inbox-send-draft: batch_confirmed in the turn the read-back was asked — the yes must come in a later message');
      return { success: false, error: BATCH_CONFIRMED_TOO_SOON, errorType: 'POLICY_HOLD' };
    }
    if (directed && !confirmed) {
      const declaredBatch = typeof batchSize === 'number' && batchSize >= 2;
      const anotherSent = turn !== undefined && [...turn.sent].some((id) => id !== draftId);
      const priorReadBack = turn?.readBackAsked === true;
      if (declaredBatch || anotherSent || priorReadBack) {
        if (turn) turn.readBackAsked = true;
        ctx.log.info({ draftId, batchSize, anotherSent, priorReadBack }, 'ceo-inbox-send-draft: unconfirmed batch send refused — read the set back first');
        const alreadySent = turn ? [...turn.sent].filter((id) => id !== draftId).length : 0;
        return { success: false, error: alreadySent > 0 ? partialBatchRefusal(alreadySent) : BATCH_READ_BACK_FIRST, errorType: 'POLICY_HOLD' };
      }
    }

    const send = ctx.outboundGateway.sendPrincipalDraft(draftId, {
      authority: { liveTurn: ctx.liveTurn, taskMetadata: ctx.taskMetadata, humanApproved: ctx.humanApproved },
      taskEventId: ctx.taskEventId,
      conversationId: ctx.conversationId,
      ...(mailbox !== undefined ? { mailbox } : {}),
    });

    // Any end the gateway did not write itself (a throw, or no answer by the deadline) has an
    // unknown outcome: the send may be past the checks, or still running and about to go out.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: PrincipalDraftSendResult | 'unfinished';
    try {
      const racers: Array<Promise<PrincipalDraftSendResult | 'unfinished'>> = [send];
      if (ctx.deadline !== undefined) {
        const waitMs = Math.max(0, ctx.deadline - SEND_DEADLINE_RESERVE_MS - Date.now());
        racers.push(new Promise((resolve) => { timer = setTimeout(() => resolve('unfinished'), waitMs); }));
      }
      result = await Promise.race(racers);
    } catch (err) {
      // May have gone out: counts as sent for this turn's batch check.
      turn?.sent.add(draftId);
      ctx.log.error({ err, draftId }, 'ceo-inbox-send-draft: send threw — outcome unknown');
      return { success: false, error: SEND_OUTCOME_UNKNOWN };
    } finally {
      clearTimeout(timer);
    }
    if (result === 'unfinished') {
      // May still go out: counts as sent for this turn's batch check.
      turn?.sent.add(draftId);
      // The gateway call keeps running; log how it ends, since the agent has already moved on.
      send.then(
        (late) => ctx.log.warn({ draftId, sent: late.success, refusal: late.success ? undefined : late.refusal }, 'ceo-inbox-send-draft: send finished after the deadline'),
        (err: unknown) => ctx.log.error({ err, draftId }, 'ceo-inbox-send-draft: send threw after the deadline'),
      );
      ctx.log.warn({ draftId }, 'ceo-inbox-send-draft: send unfinished at the deadline — outcome unknown');
      return { success: false, error: SEND_OUTCOME_UNKNOWN };
    }

    if (!result.success) {
      // Never retried: a refusal is final, and a failed send may have gone out (the gateway
      // does not retry either). Every refusal but send_unconfirmed leaves the draft in the
      // principal's Drafts folder; send_unconfirmed's text says to check Sent.
      // A limit stop's text starts with the fixed "Waiting (limit)" cue (R47): that, not a
      // structured field, is what the model sees.
      ctx.log.info({ draftId, refusal: result.refusal, refusalKind: result.refusalKind, leftAsDraft: result.leftAsDraft }, 'ceo-inbox-send-draft: not sent');
      // send_unconfirmed may have gone out: it counts as sent for this turn's batch check.
      if (result.refusal === 'send_unconfirmed') turn?.sent.add(draftId);
      // A refusal the gateway made by design carries POLICY_HOLD (#2587): held, not a hiccup.
      return gatewaySendFailure(result, 'The draft was not sent.');
    }

    turn?.sent.add(draftId);
    return {
      success: true,
      data: { message_id: result.messageId ?? '', to: result.to ?? [], subject: result.subject ?? '' },
    };
  }
}
