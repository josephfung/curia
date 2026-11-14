// handler.ts — send-draft skill implementation.
//
// Sends a Nylas draft email on explicit principal authorization.
//
// SECURITY: The task-origin check (isPrincipalOriginated(ctx.taskMetadata)) is the
// primary gate. That flag is stamped by the dispatch layer in TypeScript code before
// the coordinator sees the task — the LLM cannot set it. Observation-mode tasks
// (external emails) explicitly do not receive this flag, preventing prompt injection
// from external sources from triggering approved sends.
//
// See ADR-017 for the full reasoning behind this pattern.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { RESOLVED_BY } from '../../../../src/autonomy/action-log-types.js';
import type { NylasMessage } from '../../../../src/channels/email/nylas-client.js';
import { createHumanDecision } from '../../../../src/bus/events.js';
import { isLivePrincipalTurn, isPrincipalOriginated } from '../../../../src/contacts/principal.js';
import { isPrincipalDirectedSend } from '../../../../src/skills/_shared/principal-directed.js';
import { hasTransientErrorSignal } from '../../../../src/skills/outbound-gateway.js';
import type { TaskOriginator } from '../../../../src/contacts/types.js';
import { gatewaySendFailure } from '../../../../src/skills/_shared/policy-hold.js';

/** Result of findDraftById — either the draft + owning account, or an agent-facing error. */
type DraftDiscoveryResult =
  | { success: true; draft: NylasMessage; resolvedAccount: string }
  | { success: false; error: string };

/** One account's lookup: the draft, a definitive miss, or a failed request. */
type AccountLookup =
  | { kind: 'found'; draft: NylasMessage }
  | { kind: 'missing' }
  | { kind: 'failed'; transient: boolean; detail: string };

/**
 * Whether a failed lookup is worth retrying: 408, 429, 5xx or a network code (the
 * gateway's rule), plus the two shapes that carry neither — the SDK's own timeout and
 * Node fetch's `fetch failed`, whose socket code sits on `cause`. Anything else (a 4xx,
 * an unknown account, a programming error) fails the same way every time; calling a
 * Gmail 400 transient started days of retry tasks (#2262).
 */
function isTransientFetchError(err: unknown): boolean {
  if (hasTransientErrorSignal(err)) return true;
  if (!(err instanceof Error)) return false;
  // NylasSdkTimeoutError does not set `name`, and the SDK's ESM types do not export the class.
  if (err.constructor.name === 'NylasSdkTimeoutError') return true;
  return hasTransientErrorSignal(err.cause);
}

// Drafts ceo-inbox composes live in the principal's own mailbox, outside Curia's
// accounts. That is the usual reason a draft ID is in none of them, so the error
// points at the specialist that sends those (#2262, #2474). Only
// for a definitive miss in every account searched: a draft in an account that
// could not be read was never ruled out.
function draftNotFoundError(draftId: string, searched: string): string {
  return (
    `Draft not found: ${draftId}. Searched Curia's email accounts: ${searched}. ` +
    'Drafts in the principal\'s own mailbox aren\'t in Curia\'s accounts; the ceo-inbox specialist ' +
    'sends those: pass this draft ID to it. Do not retry this draft ID with this tool.'
  );
}

export class SendDraftHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    // ------------------------------------------------------------------
    // Step 1: Task-origin check — hard gate, must be first
    // ------------------------------------------------------------------
    // ctx.taskMetadata is populated by the agent runtime from the agent.task
    // event payload; the LLM cannot influence it. Observation-mode tasks
    // (triggered by external emails) explicitly do not receive principal origin,
    // so prompt injection from an external email cannot reach this point with
    // the flag set.
    if (!isPrincipalOriginated(ctx.taskMetadata)) {
      ctx.log.warn('send-draft: rejected — task not originated by principal');
      return {
        success: false,
        error: 'send-draft requires principal authorization. This skill can only be called from a task initiated by the principal.',
      };
    }

    if (!ctx.outboundGateway) {
      return { success: false, error: 'send-draft requires outboundGateway (capabilities: ["outboundGateway"])' };
    }

    if (!ctx.bus) {
      return { success: false, error: 'send-draft requires bus (capabilities: ["bus"])' };
    }

    // ------------------------------------------------------------------
    // Step 2: Parse inputs
    // ------------------------------------------------------------------
    const input = ctx.input && typeof ctx.input === 'object'
      ? (ctx.input as Record<string, unknown>)
      : {};
    const { draft_id: rawDraftId, account: rawAccount } = input as {
      draft_id?: string;
      account?: string;
    };

    const draftId = typeof rawDraftId === 'string' && rawDraftId.trim()
      ? rawDraftId.trim()
      : undefined;
    if (!draftId) return { success: false, error: 'Missing required input: draft_id (string)' };

    // account is optional — when omitted, the skill searches all configured accounts
    // for the draft and auto-discovers which account owns it. This fixes the bug where
    // the coordinator LLM had to guess the account name (often incorrectly, defaulting
    // to the primary account even when the draft lives in a secondary one). See #455.
    const account = typeof rawAccount === 'string' && rawAccount.trim()
      ? rawAccount.trim()
      : undefined;

    ctx.log.info({ draftId, account: account ?? '(auto-discover)' }, 'send-draft: fetching draft');

    // ------------------------------------------------------------------
    // Step 3: Fetch the draft from Nylas by ID
    // ------------------------------------------------------------------
    // Nylas's drafts resource is the source of truth — no shadow PG registry needed.
    // It is read by ID: the old list of `/messages?in=DRAFTS` was a 400 on Gmail,
    // whose label is DRAFT, and `/messages` holds no drafts anyway (#2262).
    //
    // The draft content is fetched here for two purposes:
    //   1. Verify the draft exists before attempting to send.
    //   2. Extract the primary recipient and body for the safety pipeline in
    //      gateway.sendEmailDraft() — blocked-contact check and content filter.
    //
    // When account is provided, look only in that account.
    // When omitted, iterate all configured accounts (via gateway.listAccountIds())
    // and stop at the first match. This avoids requiring the LLM to know which
    // account owns the draft — the skill derives it from the draft's location.
    const discoveryResult = await this.findDraftById(ctx, draftId, account);
    if (!discoveryResult.success) {
      return { success: false, error: discoveryResult.error };
    }
    const { draft, resolvedAccount } = discoveryResult;

    const recipient = draft.to[0]?.email;
    if (!recipient) {
      ctx.log.error({ draftId }, 'send-draft: draft has no recipient address');
      return { success: false, error: 'Draft has no recipient address' };
    }

    // ------------------------------------------------------------------
    // Step 4: Send the actual Nylas draft via gateway
    // ------------------------------------------------------------------
    // gateway.sendEmailDraft() calls Nylas's drafts.send() endpoint, which:
    //   - Sends the draft with its full envelope (all To/CC/BCC preserved)
    //   - Removes the draft from DRAFTS after sending
    //   - Honours any replyToMessageId already embedded in the draft
    //
    // humanApproved: true skips the autonomy gate (Step 0 inside the gateway) only.
    // Blocked-contact check and content filter run normally. See ADR-017.
    //
    // resolvedAccount is used for the send — either the explicit input or the
    // account discovered during draft lookup. This ensures the send always uses
    // the credentials of the account that owns the draft.
    ctx.log.info({ draftId, account: resolvedAccount, recipient }, 'send-draft: sending');

    // Build the full envelope (To + CC + BCC) so the gateway's Stage 2 audience-leak
    // judge runs over every recipient, not just the primary To. Without this, a draft
    // addressed To: principal with a CC'd/BCC'd third party would be treated as a
    // sole-principal send and skip the judge — leaking internal content. See #547.
    const allRecipients = [
      ...draft.to.map((r) => r.email),
      ...(draft.cc ?? []).map((r) => r.email),
      ...(draft.bcc ?? []).map((r) => r.email),
    ];

    // An approval replay sends the draft intact only if it is the draft the principal saw: the
    // approval's payload carries its subject and body (below), and the draft may have been
    // edited since, or the approval may predate them (#2312). Otherwise it is scanned again.
    const principalApproved = ctx.humanApproved === true
      && input['subject'] === draft.subject && input['body'] === draft.body;
    if (ctx.humanApproved === true && !principalApproved) {
      ctx.log.warn({ draftId }, 'send-draft: approved draft differs from what the approval showed — checking it for personal data again');
    }

    const sendResult = await ctx.outboundGateway.sendEmailDraft(
      draftId,
      resolvedAccount,
      { recipientEmail: recipient, body: draft.body, subject: draft.subject, allRecipients },
      // principalDirected needs a live principal turn or explicit approval. The lineage check
      // above is not enough: a woken principal-lineage task passes it too (#1870).
      {
        humanApproved: true,
        principalDirected: isPrincipalDirectedSend(ctx),
        principalApproved,
        conversationId: ctx.conversationId,
        taskEventId: ctx.taskEventId,
        // Used only if band review holds this draft (#2159): approval replays send-draft from
        // draft_id. The subject and body are stored so the approval shows the draft, and its
        // personal details, even after a restart (#2312).
        holdRecipe: {
          toolName: 'send-draft',
          partialPayload: { ...input, subject: draft.subject, body: draft.body },
          description: `Send draft to ${recipient} — "${draft.subject}"`,
        },
      },
    );

    if (!sendResult.success) {
      ctx.log.warn(
        { draftId, account: resolvedAccount, reason: sendResult.blockedReason },
        'send-draft: gateway blocked the send',
      );
      return gatewaySendFailure(sendResult, 'Send blocked by gateway');
    }

    // ------------------------------------------------------------------
    // Step 5: Transition action_log row from pending_approval → approved
    // ------------------------------------------------------------------
    // Best-effort — the email is already sent. Any failure here must not
    // surface to the principal as a skill error. The draft_id key (snake_case) is used
    // because linkGatedAction stores it as { draft_id } via the reExecRecipe pattern.
    // Rows created outside the autonomy gate will not match and are silently skipped.
    if (ctx.actionLogRepo) {
      try {
        const row = await ctx.actionLogRepo.findPendingByPayloadField('draft_id', draftId);
        if (row) {
          // The coordinator sent the draft on its reading of the conversation; recorded as
          // its decision, not the principal's (#2159).
          const updated = await ctx.actionLogRepo.resolveById(row.id, 'approved', RESOLVED_BY.coordinator);
          if (updated && row.disclosureAsk) {
            // A personal-data ask (#2312): sending the draft is the principal's yes, as
            // approve-action records it, but only from a live principal turn whose approval
            // was delivered (the principal saw its details). A yes authorizes the label on the
            // whole thread, and principal lineage alone also passes a woken task. Otherwise the
            // send stands and nothing is remembered. The recorder never throws.
            const live = isLivePrincipalTurn(ctx.liveTurn, ctx.taskMetadata);
            if (!live || row.notificationSentAt === null) {
              ctx.log.info(
                { rowId: row.id, liveTurn: live, delivered: row.notificationSentAt !== null },
                'send-draft: not recording the principal\'s yes — not a live principal turn, or the approval was never shown',
              );
            } else if (ctx.disclosureDecisions) {
              await ctx.disclosureDecisions.recordForApproval(row, 'yes', 'principal_via_coordinator');
            } else {
              ctx.log.error({ rowId: row.id }, 'send-draft: disclosureDecisions not wired — the principal\'s yes is not remembered for the thread');
            }
          }
          if (!updated) {
            // Row was present during find but couldn't be resolved — likely a concurrent
            // approval (e.g. two principal messages sent in quick succession). Log at warn so
            // the gap is visible, but don't fail the send (draft was already sent above).
            ctx.log.warn(
              { draftId, rowId: row.id },
              'send-draft: action_log row was already resolved — possible concurrent approval; no action taken',
            );
          }
        }
      } catch (err) {
        // Best-effort — the email was already sent. Failure here leaves the row in
        // pending_approval, so it will appear in the next digest. Log at error so the
        // stuck row is visible in alerting and can be cleaned up manually.
        ctx.log.error(
          { err, draftId },
          'send-draft: failed to transition action_log row — row will remain pending_approval and appear in next digest',
        );
      }
    }

    // ------------------------------------------------------------------
    // Step 6: Publish human.decision audit event
    // ------------------------------------------------------------------
    // Non-fatal: the message is already sent. If bus publish fails, log at error
    // so the missing audit trail is visible in alerting, but don't fail the skill.
    //
    // originator is stamped by the dispatcher on every task and carries the contactId
    // and channel of whoever initiated the task chain. Must be present if we passed
    // the task-origin check — if missing, that indicates a dispatch-layer bug.
    // Log loudly but don't block the send (the principal explicitly asked for it).
    // See ADR-017.
    const originator = ctx.taskMetadata?.originator as TaskOriginator | undefined;
    const senderId = originator?.contactId;
    const channelId = originator?.channel;

    if (!senderId || !channelId || !ctx.taskEventId) {
      // Provenance fields are missing — this indicates a dispatch-layer bug.
      // Log loudly so the missing audit trail is visible in alerting, but don't
      // block the send (the principal explicitly asked for it). Do NOT publish a
      // human.decision with fake IDs — a counterfeit audit row is worse than no row.
      ctx.log.error(
        { senderId, channelId, taskEventId: ctx.taskEventId },
        'send-draft: audit metadata incomplete — originator/taskEventId should always be present when task is principal-originated. This indicates a dispatch-layer bug.',
      );
    } else {
      try {
        await ctx.bus.publish(
          'dispatch',
          createHumanDecision({
            decision: 'approve',
            deciderId: senderId,
            deciderChannel: channelId,
            // subjectEventId: the task event that drove the principal's "send it" instruction.
            subjectEventId: ctx.taskEventId,
            subjectSummary: `principal authorized send of draft '${draft.subject}' to ${recipient}`,
            contextShown: ['draft_id', 'draft_subject', 'draft_recipient'],
            // presentedAt: draft creation time as proxy for when the decision was presented.
            presentedAt: new Date(draft.date * 1000),
            decidedAt: new Date(),
            defaultAction: 'block',
            parentEventId: ctx.taskEventId,
          }),
        );
      } catch (err) {
        ctx.log.error(
          { err, draftId },
          'send-draft: failed to publish human.decision event — message was sent but audit event is missing',
        );
      }
    }

    ctx.log.info(
      { draftId, messageId: sendResult.messageId, recipient },
      'send-draft: sent successfully',
    );

    return {
      success: true,
      data: {
        message_id: sendResult.messageId ?? '',
        to: recipient,
        subject: draft.subject,
      },
    };
  }

  // ------------------------------------------------------------------
  // Private: draft discovery
  // ------------------------------------------------------------------

  /**
   * Find a draft by ID, either in a specific account or across all accounts.
   *
   * When `account` is provided, looks only in that account.
   * When omitted, iterates all configured accounts (via gateway.listAccountIds())
   * and returns the first match along with the account that owns it.
   *
   * This is the core fix for #455: the coordinator no longer needs to guess which
   * account a draft lives in — the skill discovers it automatically.
   */
  private async findDraftById(
    ctx: ToolContext,
    draftId: string,
    account: string | undefined,
  ): Promise<DraftDiscoveryResult> {
    const gateway = ctx.outboundGateway!;

    // A named account is the only one searched; otherwise every configured account is.
    const accountIds = account ? [account] : gateway.listAccountIds();
    if (accountIds.length === 0) {
      return { success: false, error: 'No email accounts configured' };
    }

    // Stop at the first match. Misses and failures are kept for the error message.
    const missed: string[] = [];
    const failures: Array<{ account: string; transient: boolean; detail: string }> = [];
    for (const acctId of accountIds) {
      const lookup = await this.lookUpDraft(ctx, gateway, draftId, acctId);
      if (lookup.kind === 'found') return { success: true, draft: lookup.draft, resolvedAccount: acctId };
      if (lookup.kind === 'missing') missed.push(acctId);
      else failures.push({ account: acctId, transient: lookup.transient, detail: lookup.detail });
    }

    if (failures.length === 0) {
      ctx.log.warn({ draftId, searchedAccounts: accountIds }, 'send-draft: draft not found in any account');
      return { success: false, error: draftNotFoundError(draftId, accountIds.join(', ')) };
    }

    // An account that could not be read may hold the draft, so this is not "not found".
    // One transient failure makes the whole lookup worth retrying, even beside a 400:
    // the retry reaches the account that timed out.
    const transient = failures.some((f) => f.transient);
    ctx.log.error(
      { draftId, missedAccounts: missed, failures, transient },
      'send-draft: draft lookup failed in at least one account — cannot confirm draft existence',
    );
    const details = failures.map((f) => `${f.account}: ${f.detail}`).join('; ');
    const missNote = missed.length > 0 ? ` It is not in ${missed.join(', ')}.` : '';
    return {
      success: false,
      error: transient
        ? `Could not search for draft ${draftId} (${details}).${missNote} This is likely a transient API issue — try again shortly.`
        : `Could not search for draft ${draftId} (${details}).${missNote} This is not a temporary outage, so retrying ` +
          'will fail the same way. Tell the principal the draft could not be sent.',
    };
  }

  /** Look up a draft by ID in a single account. */
  private async lookUpDraft(
    ctx: ToolContext,
    gateway: NonNullable<ToolContext['outboundGateway']>,
    draftId: string,
    account: string,
  ): Promise<AccountLookup> {
    let draft: NylasMessage | null;
    try {
      draft = await gateway.getEmailDraft(draftId, account);
    } catch (err) {
      const transient = isTransientFetchError(err);
      ctx.log.error({ err, account, transient }, 'send-draft: draft lookup failed');
      return { kind: 'failed', transient, detail: err instanceof Error ? err.message : String(err) };
    }

    if (!draft) {
      ctx.log.debug({ draftId, account }, 'send-draft: draft not in this account');
      return { kind: 'missing' };
    }

    ctx.log.info({ draftId, account }, 'send-draft: draft found');
    return { kind: 'found', draft };
  }
}
