// handler.ts — send-draft skill implementation.
//
// Sends a Nylas draft email on explicit CEO authorization.
//
// SECURITY: The task-origin check (isPrincipalOriginated(ctx.taskMetadata)) is the
// primary gate. That flag is stamped by the dispatch layer in TypeScript code before
// the coordinator sees the task — the LLM cannot set it. Observation-mode tasks
// (external emails) explicitly do not receive this flag, preventing prompt injection
// from external sources from triggering approved sends.
//
// See ADR-017 for the full reasoning behind this pattern.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { NylasMessage } from '../../src/channels/email/nylas-client.js';
import { createHumanDecision } from '../../src/bus/events.js';
import { isPrincipalOriginated } from '../../src/contacts/principal.js';

/** Result of findDraftById — either the draft + owning account, or a structured error. */
type DraftDiscoveryResult =
  | { success: true; draft: NylasMessage; resolvedAccount: string }
  | { success: false; error: string; reason: 'not_found' | 'fetch_error' };

export class SendDraftHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
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
    // Step 3: Fetch draft from Nylas DRAFTS folder
    // ------------------------------------------------------------------
    // The Nylas DRAFTS folder is the source of truth — no shadow PG registry needed.
    // We list all drafts and filter client-side by ID; Nylas doesn't support
    // a direct draft-by-ID lookup via the messages API.
    //
    // The draft content is fetched here for two purposes:
    //   1. Verify the draft exists before attempting to send.
    //   2. Extract the primary recipient and body for the safety pipeline in
    //      gateway.sendEmailDraft() — blocked-contact check and content filter.
    //
    // When account is provided, search only that account's DRAFTS folder.
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

    const sendResult = await ctx.outboundGateway.sendEmailDraft(
      draftId,
      resolvedAccount,
      { recipientEmail: recipient, body: draft.body, subject: draft.subject },
      { humanApproved: true },
    );

    if (!sendResult.success) {
      ctx.log.warn(
        { draftId, account: resolvedAccount, reason: sendResult.blockedReason },
        'send-draft: gateway blocked the send',
      );
      return { success: false, error: sendResult.blockedReason ?? 'Send blocked by gateway' };
    }

    // ------------------------------------------------------------------
    // Step 5: Transition action_log row from pending_approval → approved
    // ------------------------------------------------------------------
    // Best-effort — the email is already sent. Any failure here must not
    // surface to the CEO as a skill error. The draft_id key (snake_case) is used
    // because linkGatedAction stores it as { draft_id } via the reExecRecipe pattern.
    // Rows created outside the autonomy gate will not match and are silently skipped.
    if (ctx.actionLogRepo) {
      try {
        const row = await ctx.actionLogRepo.findPendingByPayloadField('draft_id', draftId);
        if (row) {
          const updated = await ctx.actionLogRepo.resolveById(row.id, 'approved', 'ceo');
          if (!updated) {
            // Row was present during find but couldn't be resolved — likely a concurrent
            // approval (e.g. two CEO messages sent in quick succession). Log at warn so
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
    // senderId and channelId are stamped by the dispatcher in the same originatorContext object
    // as principal origin, so they must be present if we passed the task-origin check.
    // If they're missing, that indicates a dispatch-layer bug — log loudly but don't
    // block the send (the principal explicitly asked for it). See ADR-017.
    const senderId = typeof ctx.taskMetadata?.senderId === 'string'
      ? ctx.taskMetadata.senderId
      : undefined;
    const channelId = typeof ctx.taskMetadata?.channelId === 'string'
      ? ctx.taskMetadata.channelId
      : undefined;

    if (!senderId || !channelId || !ctx.taskEventId) {
      ctx.log.error(
        { senderId, channelId, taskEventId: ctx.taskEventId },
        'send-draft: audit metadata incomplete — senderId/channelId/taskEventId should always be present when task is principal-originated. This indicates a dispatch-layer bug.',
      );
    }

    try {
      await ctx.bus.publish(
        'dispatch',
        createHumanDecision({
          decision: 'approve',
          deciderId: senderId ?? 'unknown:dispatch-bug',
          deciderChannel: channelId ?? 'unknown:dispatch-bug',
          // subjectEventId: the task event that drove the CEO's "send it" instruction.
          subjectEventId: ctx.taskEventId ?? '',
          subjectSummary: `CEO authorized send of draft '${draft.subject}' to ${recipient}`,
          contextShown: ['draft_id', 'draft_subject', 'draft_recipient'],
          // presentedAt: draft creation time as proxy for when the decision was presented.
          presentedAt: new Date(draft.date * 1000),
          decidedAt: new Date(),
          defaultAction: 'block',
          parentEventId: ctx.taskEventId ?? '',
        }),
      );
    } catch (err) {
      ctx.log.error(
        { err, draftId },
        'send-draft: failed to publish human.decision event — message was sent but audit event is missing',
      );
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
   * When `account` is provided, searches only that account's DRAFTS folder.
   * When omitted, iterates all configured accounts (via gateway.listAccountIds())
   * and returns the first match along with the account that owns it.
   *
   * This is the core fix for #455: the coordinator no longer needs to guess which
   * account a draft lives in — the skill discovers it automatically.
   */
  private async findDraftById(
    ctx: SkillContext,
    draftId: string,
    account: string | undefined,
  ): Promise<DraftDiscoveryResult> {
    const gateway = ctx.outboundGateway!;

    // Fast path: caller specified the account — search only that one.
    if (account) {
      return this.searchAccountForDraft(ctx, gateway, draftId, account);
    }

    // Slow path: search all accounts. Stop at the first match.
    const accountIds = gateway.listAccountIds();
    if (accountIds.length === 0) {
      return { success: false, error: 'No email accounts configured', reason: 'fetch_error' };
    }

    // Track which accounts failed so the error message is informative.
    const failedAccounts: string[] = [];
    for (const acctId of accountIds) {
      const result = await this.searchAccountForDraft(ctx, gateway, draftId, acctId);
      if (result.success) return result;
      if (result.reason === 'fetch_error') {
        failedAccounts.push(acctId);
      }
    }

    // When every account had a fetch error, the draft was never actually searched —
    // return a distinct message so the CEO knows it's a transient API issue, not a
    // missing draft. Without this, a complete Nylas outage reads as "Draft not found."
    if (failedAccounts.length === accountIds.length) {
      ctx.log.error(
        { draftId, failedAccounts },
        'send-draft: all accounts failed during draft search — cannot confirm draft existence',
      );
      return {
        success: false,
        reason: 'fetch_error',
        error: `Could not search for draft ${draftId}: all email accounts had fetch errors (${failedAccounts.join(', ')}). This is likely a transient API issue — try again shortly.`,
      };
    }

    const searched = accountIds.join(', ');
    const failNote = failedAccounts.length > 0
      ? ` (accounts with fetch errors: ${failedAccounts.join(', ')})`
      : '';
    ctx.log.warn(
      { draftId, searchedAccounts: accountIds, failedAccounts },
      'send-draft: draft not found in any account',
    );
    return {
      success: false,
      reason: 'not_found',
      error: `Draft not found: ${draftId}. Searched accounts: ${searched}.${failNote}`,
    };
  }

  /** Search a single account's DRAFTS folder for a draft by ID. */
  private async searchAccountForDraft(
    ctx: SkillContext,
    gateway: NonNullable<SkillContext['outboundGateway']>,
    draftId: string,
    account: string,
  ): Promise<DraftDiscoveryResult> {
    let drafts: Awaited<ReturnType<typeof gateway.listEmailMessages>>;
    try {
      drafts = await gateway.listEmailMessages({ folders: ['DRAFTS'] }, account);
    } catch (err) {
      ctx.log.error({ err, account }, 'send-draft: failed to fetch DRAFTS folder');
      return { success: false, reason: 'fetch_error', error: `Failed to fetch drafts folder for account '${account}'` };
    }

    const draft = drafts.find((m) => m.id === draftId);
    if (!draft) {
      ctx.log.debug({ draftId, account }, 'send-draft: draft not in this account');
      return { success: false, reason: 'not_found', error: `Draft not found: ${draftId}` };
    }

    ctx.log.info(
      { draftId, account },
      'send-draft: draft found',
    );
    return { success: true, draft, resolvedAccount: account };
  }
}
