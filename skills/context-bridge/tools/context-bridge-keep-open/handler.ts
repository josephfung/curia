//
// Keeps an outbound-context entry active past the end of the delegation that is
// handling it (#1972).
//
// When the coordinator routes the principal's reply to the specialist that owns
// an entry, it passes the entry to `delegate` as outbound_entry_id, and the
// platform releases the entry when the specialist returns. This tool is the
// specialist's structured way to say "not yet": the exchange still needs another
// answer from the principal on this entry. The mark carries this delegated task's
// id, so it holds only the release this delegation triggers.
//
// Only a delegated specialist can call it — `delegate` stamps delegationOrigin on
// every task it publishes, and nothing else does — so the coordinator cannot use
// it to keep entries it routed.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { isUuid } from '../../../../src/util/uuid.js';
import { delegationHintOwner } from '../../../../src/dispatch/delegation-hint.js';

export class ContextBridgeKeepOpenHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { entry_id: rawEntryId, reason: rawReason } = ctx.input as { entry_id?: unknown; reason?: unknown };
    const entryId = typeof rawEntryId === 'string' ? rawEntryId.trim() : '';
    const reason = typeof rawReason === 'string' && rawReason.trim().length > 0 ? rawReason.trim() : undefined;

    if (!isUuid(entryId)) {
      return {
        success: false,
        error: `Invalid entry_id "${entryId}" — expected the outbound-context entry UUID named in your task brief.`,
      };
    }
    if (!ctx.outboundContext) {
      return { success: false, error: 'context-bridge-keep-open requires outboundContext capability.' };
    }
    if (!ctx.taskMetadata?.['delegationOrigin'] || !ctx.taskEventId || !ctx.agentId) {
      return {
        success: false,
        error:
          'context-bridge-keep-open only works inside a delegated task that is handling a reply to this entry. ' +
          'Outside one there is no release to hold, so there is nothing to do.',
      };
    }

    try {
      const entry = await ctx.outboundContext.getEntry(entryId);
      if (!entry) {
        return { success: false, error: 'outbound context entry not found or already released' };
      }
      const owner = delegationHintOwner(entry.delegationHint);
      if (owner && owner !== ctx.agentId) {
        return {
          success: false,
          error: `Entry ${entryId} is owned by ${owner}, not ${ctx.agentId}; only its owner can keep it open.`,
        };
      }
      const marked = await ctx.outboundContext.markExchangeOpen(entryId, {
        agentId: ctx.agentId,
        taskEventId: ctx.taskEventId,
        ...(reason ? { reason } : {}),
      });
      if (!marked) {
        // Released or expired between the read and the write — say so rather than
        // claim the entry will stay open.
        return { success: false, error: 'outbound context entry not found or already released' };
      }
      ctx.log.info({ entryId, agentId: ctx.agentId }, 'Outbound context entry kept open past the delegation');
      return { success: true, data: { kept_open: entryId } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, entryId }, 'Failed to keep outbound context entry open');
      return { success: false, error: `Failed to keep the entry open: ${message}` };
    }
  }
}
