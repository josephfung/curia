// console-approval.ts — approve or discard a held action from the principal home (#2340).
//
// Same steps as approve-action / deny-action, with resolved_by 'console' because
// the principal clicked in the web console rather than reacting in chat.
// A held send-draft is deleted before the row is denied, so the message cannot go out.
// Review shows the held content. Approving from here counts as the principal having seen it.

import type { ActionLogRepo } from '../autonomy/action-log-repo.js';
import type { ActionLogRow } from '../autonomy/action-log-types.js';
import { RESOLVED_BY } from '../autonomy/action-log-types.js';
import { hasPersonalDetails } from '../autonomy/approval-notification.js';
import type { DisclosureDecisionRecorder } from '../autonomy/disclosure-decisions.js';
import type { EventBus } from '../bus/bus.js';
import { createHumanDecision } from '../bus/events.js';
import type { TaskOriginator } from '../contacts/types.js';
import type { Logger } from '../logger.js';
import type { ExecutionLayer } from '../skills/execution.js';
import { STALE_SEND_APPROVAL_ERROR } from '../skills/_shared/recipient-reference.js';
import { approvalNeedsDraft, approvalReviewSummary, mailboxDraftRef } from './briefing.js';

export type ApprovalOutcome =
  | { ok: true; sent: boolean }
  | { ok: false; status: number; error: string };

export interface ApprovalReview {
  summary: string;
  canApprove: boolean;
  blockReason: string | null;
}

/** Shown in the console. The principal cannot call deliver-approval. */
export const CONSOLE_REVIEW_REQUIRED_ERROR =
  'Review this item before approving. The message is in the panel above.';

/** A send-draft whose body could not be loaded must not be approved unseen. */
export const DRAFT_UNAVAILABLE_ERROR =
  'This draft could not be loaded, so it cannot be approved from here. Open it in chat.';

export interface HeldDraftView {
  account: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
}

export interface ConsoleApprovalDeps {
  actionLogRepo: Pick<ActionLogRepo, 'resolveRow' | 'rejectStaleApproval' | 'insert'>;
  executionLayer?: Pick<ExecutionLayer, 'invoke' | 'confirmPinnedSendResolution'>;
  disclosureDecisions?: Pick<DisclosureDecisionRecorder, 'recordForApproval'>;
  deleteMailboxDraft?: (account: string | undefined, draftId: string) => Promise<void>;
  /** Reads a held send-draft, searching every mailbox when account is omitted. */
  loadHeldDraft?: (account: string | undefined, draftId: string) => Promise<HeldDraftView | null>;
  bus?: Pick<EventBus, 'publish'>;
  principalContactId: string | null;
  logger: Logger;
}

function stillPending(row: ActionLogRow, now: Date): ApprovalOutcome | null {
  if (row.outcome !== 'pending_approval') {
    return { ok: false, status: 409, error: 'That item is no longer waiting.' };
  }
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, status: 409, error: 'That approval has expired.' };
  }
  return null;
}

function mergeDraft(payload: Record<string, unknown>, draft: HeldDraftView): Record<string, unknown> {
  return {
    ...payload,
    account: draft.account,
    to: draft.to,
    ...(draft.cc.trim().length > 0 ? { cc: draft.cc } : {}),
    subject: draft.subject,
    body: draft.body,
  };
}

/**
 * The payload the principal is shown. A send-draft that stored only an id is filled
 * from the mailbox. Failure here means Approve must stay disabled.
 */
async function payloadForReview(
  row: ActionLogRow,
  deps: Pick<ConsoleApprovalDeps, 'loadHeldDraft' | 'logger'>,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const payload = row.payload ?? {};
  if (!approvalNeedsDraft(row.toolName, row.payload)) {
    return { ok: true, payload };
  }
  const draft = mailboxDraftRef(row.toolName, row.payload);
  if (!draft) return { ok: true, payload };
  if (!deps.loadHeldDraft) {
    return { ok: false, status: 503, error: DRAFT_UNAVAILABLE_ERROR };
  }
  try {
    const loaded = await deps.loadHeldDraft(draft.account, draft.draftId);
    if (!loaded) return { ok: false, status: 409, error: DRAFT_UNAVAILABLE_ERROR };
    return { ok: true, payload: mergeDraft(payload, loaded) };
  } catch (err) {
    deps.logger.error({ err, rowId: row.id, draftId: draft.draftId }, 'console-approval: draft read failed');
    return { ok: false, status: 502, error: DRAFT_UNAVAILABLE_ERROR };
  }
}

/** Review text for one held row, including a mailbox draft when the payload omitted it. */
export async function reviewFromConsole(
  row: ActionLogRow,
  deps: Pick<ConsoleApprovalDeps, 'loadHeldDraft' | 'logger'>,
): Promise<ApprovalReview> {
  const loaded = await payloadForReview(row, deps);
  if (!loaded.ok) {
    return { summary: loaded.error, canApprove: false, blockReason: loaded.error };
  }
  return {
    summary: approvalReviewSummary({
      description: row.description,
      toolName: row.toolName,
      payload: loaded.payload,
    }),
    canApprove: true,
    blockReason: null,
  };
}

function mustBeShown(row: ActionLogRow, payload: Record<string, unknown>): boolean {
  return row.notificationSentAt === null && (Boolean(row.disclosureAsk) || hasPersonalDetails(row.toolName, payload));
}

async function publishDecision(
  deps: ConsoleApprovalDeps,
  row: ActionLogRow,
  decision: 'approve' | 'deny',
): Promise<void> {
  if (!deps.bus || !deps.principalContactId) return;
  try {
    await deps.bus.publish('system', createHumanDecision({
      decision,
      deciderId: deps.principalContactId,
      deciderChannel: 'web',
      subjectEventId: row.taskId,
      subjectSummary: `principal ${decision === 'approve' ? 'approved' : 'denied'} from the console: ${row.description ?? row.toolName}`,
      contextShown: ['description', 'skill_name', 'payload'],
      presentedAt: row.createdAt,
      decidedAt: new Date(),
      defaultAction: 'block',
      parentEventId: row.taskId,
    }));
  } catch (err) {
    deps.logger.error({ err, rowId: row.id }, 'console-approval: failed to publish human.decision');
  }
}

async function rememberDisclosure(
  deps: ConsoleApprovalDeps,
  row: ActionLogRow,
  decision: 'yes' | 'no',
  shown: boolean,
): Promise<void> {
  if (!row.disclosureAsk) return;
  // A chat notification already showed it, or the console review panel did.
  if (row.notificationSentAt === null && !shown) return;
  if (!deps.disclosureDecisions) {
    deps.logger.error({ rowId: row.id }, 'console-approval: disclosureDecisions not wired — the decision is not remembered for the thread');
    return;
  }
  // The disclosure table only records reaction or coordinator paths. The console
  // is the principal deciding, same as a coordinator-mediated answer.
  await deps.disclosureDecisions.recordForApproval(row, decision, 'principal_via_coordinator');
}

export interface ApproveOptions {
  /** True only after the console rendered the review text for this row. */
  shown?: boolean;
}

/**
 * Approve a pending row and re-run the blocked tool. Not undoable: the send may already have left.
 */
export async function approveFromConsole(
  row: ActionLogRow,
  deps: ConsoleApprovalDeps,
  now: Date = new Date(),
  options: ApproveOptions = {},
): Promise<ApprovalOutcome> {
  const blocked = stillPending(row, now);
  if (blocked) return blocked;
  if (!row.payload) {
    return { ok: false, status: 400, error: 'This approval has nothing stored to run.' };
  }
  if (!deps.executionLayer) {
    return { ok: false, status: 503, error: 'Approvals cannot be sent right now.' };
  }
  if (!deps.principalContactId) {
    return { ok: false, status: 503, error: 'No principal is configured.' };
  }

  const loaded = await payloadForReview(row, deps);
  if (!loaded.ok) return loaded;
  if (mustBeShown(row, loaded.payload) && options.shown !== true) {
    return { ok: false, status: 409, error: CONSOLE_REVIEW_REQUIRED_ERROR };
  }

  const pins = row.sendResolution;
  if (pins && pins.length > 0) {
    const still = await deps.executionLayer.confirmPinnedSendResolution(row.toolName, pins);
    if (!still.ok) {
      await deps.actionLogRepo.rejectStaleApproval(row.id);
      return { ok: false, status: 409, error: STALE_SEND_APPROVAL_ERROR };
    }
  }

  const transitioned = await deps.actionLogRepo.resolveRow(row.id, 'approved', RESOLVED_BY.console);
  if (!transitioned) {
    return { ok: false, status: 409, error: 'That item is no longer waiting.' };
  }

  await rememberDisclosure(deps, row, 'yes', options.shown === true);

  const originator: TaskOriginator = {
    contactId: deps.principalContactId,
    systemRole: 'principal',
    channel: 'web',
    initiatedAt: now.toISOString(),
    tier: 'principal',
  };
  const reResult = await deps.executionLayer.invoke(
    row.toolName,
    row.payload,
    { contactId: deps.principalContactId, role: 'ceo', channel: 'web' },
    {
      humanApproved: true,
      // The principal is approving in an authenticated console session right now. A queued
      // elevated skill (#2495) needs that live turn to pass its gate on replay.
      liveTurn: true,
      sendResolution: pins ?? undefined,
      conversationId: row.conversationId ?? undefined,
      taskEventId: row.taskId,
      taskMetadata: { originator },
    },
  );

  try {
    await deps.actionLogRepo.insert({
      taskId: row.taskId,
      conversationId: row.conversationId ?? undefined,
      toolName: row.toolName,
      actionRisk: row.actionRisk,
      outcome: reResult.success ? 'success' : 'failure',
      taskSummary: reResult.success ? undefined : reResult.error,
      parentActionId: row.id,
    });
  } catch (err) {
    deps.logger.error({ err, rowId: row.id }, 'console-approval: failed to insert child action_log row');
  }

  await publishDecision(deps, row, 'approve');
  deps.logger.info({ rowId: row.id, sent: reResult.success }, 'console-approval: approved');
  return { ok: true, sent: reResult.success };
}

/**
 * Discard a pending row. The blocked tool is not run. A linked mailbox draft is deleted first;
 * if that delete fails the row stays pending so the principal can retry.
 */
export async function denyFromConsole(
  row: ActionLogRow,
  deps: ConsoleApprovalDeps,
  now: Date = new Date(),
): Promise<ApprovalOutcome> {
  const blocked = stillPending(row, now);
  if (blocked) return blocked;

  const draft = mailboxDraftRef(row.toolName, row.payload);
  if (draft) {
    if (!deps.deleteMailboxDraft) {
      return { ok: false, status: 503, error: 'The mailbox draft could not be deleted.' };
    }
    try {
      // account may be undefined: the deleter searches every mailbox rather than
      // assuming the primary one.
      await deps.deleteMailboxDraft(draft.account, draft.draftId);
    } catch (err) {
      deps.logger.error({ err, rowId: row.id, draftId: draft.draftId }, 'console-approval: draft delete failed — row left pending');
      return { ok: false, status: 502, error: 'The mailbox draft could not be deleted.' };
    }
  }

  const transitioned = await deps.actionLogRepo.resolveRow(row.id, 'denied', RESOLVED_BY.console);
  if (!transitioned) {
    return { ok: false, status: 409, error: 'That item is no longer waiting.' };
  }

  await rememberDisclosure(deps, row, 'no', false);
  await publishDecision(deps, row, 'deny');
  deps.logger.info({ rowId: row.id, draftDeleted: draft !== null }, 'console-approval: denied');
  return { ok: true, sent: false };
}
