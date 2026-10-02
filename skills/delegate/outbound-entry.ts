// outbound-entry.ts — delegate's ownership of the outbound-context entry whose
// reply it routes (#1972).
//
// When the principal answers a message sent on a specialist's behalf, the
// coordinator routes the answer to that specialist with `delegate`. Deciding when
// the matching [ACTIVE OUTBOUND CONTEXT] entry is finished used to be the
// coordinator's job, judged from the specialist's prose; on the production model
// it released entries after interim results. The decision now lives here, made
// from the shape of the delegate result:
//
// - The specialist took the reply (a normal answer, a clarification request, a
//   paused long task): release the entry. A clarification is relayed as a new
//   message with its own entry and resume_token, so keeping the old entry would
//   let the principal's next answer match a stale one. The specialist can hold
//   the release with context-bridge-keep-open when the exchange really is still
//   open on this entry.
// - The specialist never took it (failure, timeout, decline, in-flight refusal,
//   any delegate error): keep the entry, so the principal's reply is not lost.
//
// None of this may block or fail the delegation itself: routing the principal's
// answer matters more than tidying the entry. Every lookup or release failure is
// logged and the delegation proceeds unlinked.

import type { ToolContext, ToolResult } from '../../src/skills/types.js';
import { delegationHintOwner } from '../../src/dispatch/delegation-hint.js';
import { isUuid, UUID_PATTERN } from '../../src/util/uuid.js';

export interface LinkedOutboundEntry {
  entryId: string;
  /** How the entry was linked: the structured input, or its id quoted in the brief. */
  source: 'input' | 'task_text';
}

// Composed from the shared pattern (src/util/uuid.ts); /g finds every id quoted in the brief.
const QUOTED_UUID_RE = new RegExp(`\\b${UUID_PATTERN}\\b`, 'g');
/** Bound on brief-quoted ids looked up, so a brief full of ids cannot fan out reads. */
const MAX_QUOTED_IDS = 5;

/**
 * Resolve the entry this delegation answers, or null.
 *
 * `outbound_entry_id` links any active entry that the target owns or that has no
 * owner; one owned by a different agent is not linked (the coordinator may still
 * route there, but the platform will not release another agent's entry). Without
 * the input, an id quoted in the brief is linked only when its entry is owned by
 * the target — the same evidence the coordinator's transfer-ownership rule acts on
 * — and only when exactly one quoted id qualifies.
 */
export async function linkOutboundEntry(
  ctx: ToolContext,
  agent: string,
  task: string,
  explicit: unknown,
): Promise<LinkedOutboundEntry | null> {
  const outboundContext = ctx.outboundContext;
  if (!outboundContext) return null;

  try {
    if (typeof explicit === 'string' && explicit.trim().length > 0) {
      const entryId = explicit.trim();
      if (!isUuid(entryId)) {
        ctx.log.warn({ targetAgent: agent, outboundEntryId: entryId }, 'delegate: outbound_entry_id is not a UUID — delegating unlinked');
        return null;
      }
      const entry = await outboundContext.getEntry(entryId);
      if (!entry) {
        ctx.log.warn({ targetAgent: agent, entryId }, 'delegate: outbound_entry_id is not an active entry — delegating unlinked');
        return null;
      }
      const owner = delegationHintOwner(entry.delegationHint);
      if (owner && owner !== agent) {
        ctx.log.warn(
          { targetAgent: agent, entryId, owner },
          'delegate: outbound_entry_id is owned by another agent — delegating unlinked, entry left active',
        );
        return null;
      }
      return { entryId, source: 'input' };
    }

    const quoted = [...new Set(task.match(QUOTED_UUID_RE)?.map(id => id.toLowerCase()) ?? [])].slice(0, MAX_QUOTED_IDS);
    const owned: string[] = [];
    for (const id of quoted) {
      const entry = await outboundContext.getEntry(id);
      if (entry && delegationHintOwner(entry.delegationHint) === agent) owned.push(id);
    }
    if (owned.length === 1) {
      ctx.log.info({ targetAgent: agent, entryId: owned[0] }, 'delegate: linked the outbound-context entry quoted in the brief');
      return { entryId: owned[0]!, source: 'task_text' };
    }
    if (owned.length > 1) {
      ctx.log.warn({ targetAgent: agent, entryIds: owned }, 'delegate: brief quotes several entries the target owns — delegating unlinked');
    }
    return null;
  } catch (err) {
    ctx.log.error({ err, targetAgent: agent }, 'delegate: outbound-context entry lookup failed — delegating unlinked');
    return null;
  }
}

/** Line appended to the specialist's brief naming the entry it is answering. */
export function outboundEntryNote(entryId: string): string {
  return (
    `\n\n[Outbound context] This task answers the principal's reply to outbound-context entry ${entryId}. ` +
    'The platform releases that entry when you return, after which the principal\'s next message no longer routes to you.'
  );
}

/** True when the specialist received and handled the reply (see the header). */
export function replyWasTaken(result: ToolResult): boolean {
  if (!result.success) return false;
  const data = result.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return false;
  return data['failed'] !== true && data['in_flight'] !== true && data['declined'] !== true && data['blocked'] !== true;
}

/** Release or keep the linked entry once the delegation has a result. Never throws. */
export async function settleOutboundEntry(
  ctx: ToolContext,
  link: LinkedOutboundEntry,
  result: ToolResult,
  delegatedTaskId: string | undefined,
): Promise<void> {
  const log = { entryId: link.entryId, linkedVia: link.source };
  if (!replyWasTaken(result)) {
    ctx.log.info(log, 'delegate: specialist did not take the reply — outbound-context entry kept active');
    return;
  }
  if (!ctx.outboundContext || !delegatedTaskId) {
    // A taken reply always has a published task; reaching here is a wiring bug.
    ctx.log.error({ ...log, hasTaskId: delegatedTaskId !== undefined }, 'delegate: cannot settle outbound-context entry — entry left active');
    return;
  }
  try {
    const outcome = await ctx.outboundContext.releaseUnlessKeptOpen(link.entryId, delegatedTaskId);
    ctx.log.info({ ...log, outcome }, 'delegate: settled outbound-context entry');
  } catch (err) {
    ctx.log.error({ ...log, err }, 'delegate: failed to release outbound-context entry — it stays active until expiry');
  }
}
