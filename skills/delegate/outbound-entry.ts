// outbound-entry.ts — delegate's ownership of the outbound-context entry whose
// reply it routes (#1972).
//
// When the principal answers a message sent on a specialist's behalf, the
// coordinator routes the answer to that specialist with `delegate`. Deciding when
// the matching [ACTIVE OUTBOUND CONTEXT] entry is finished used to be the
// coordinator's job, judged from the specialist's prose; on the production model
// it released entries after interim results. The decision now lives here, made
// from the shape of the delegate result (see `settlementFor`):
//
// - Keep the entry only while routing the reply again could still work: no
//   specialist run started (in-flight refusal, guard block, a brief rejected
//   before dispatch) or the run failed retryably.
// - Release it on every other outcome: an answer, a clarification request (the
//   follow-up is relayed as a new entry with the new resume_token, and keeping
//   the old one would let the principal's next answer match a stale entry), a
//   paused long task, a decline, a non-retryable failure, and a wait timeout
//   (the specialist has the reply; late delivery carries its answer). A resume
//   whose token cannot be decoded also releases: that entry can only ever route
//   the principal into the same dead resume.
//
// The specialist can hold a release with context-bridge-keep-open. Task-wake
// bindings are never linked — the coordinator closes those with
// context-bridge-release and `reply`, which also persists the answer.
//
// None of this may block or fail the delegation itself: routing the principal's
// answer matters more than tidying the entry. Lookup and release failures are
// logged, and what happened is reported to the coordinator on the result as
// `outbound_entry`, so a wrong id or owner is visible to the model that chose it.

import type { ToolContext, ToolResult } from '../../src/skills/types.js';
import { delegationHintOwner, rosterFromRegistry, type DelegationHintRoster } from '../../src/dispatch/delegation-hint.js';
import { isTaskWakeReplyBinding } from '../../src/dispatch/task-wake-reply.js';
import { decodeResumeToken } from '../../src/agents/resume-token.js';
import { isUuid, UUID_PATTERN } from '../../src/util/uuid.js';

export interface LinkedOutboundEntry {
  entryId: string;
  /** How the entry was linked: the structured input, or its id quoted in the brief. */
  source: 'input' | 'task_text';
}

/** What the platform did with the entry, reported on the delegate result. */
export type OutboundEntryReport =
  | { id: string; status: 'released' | 'kept_open' | 'kept' | 'already_released' | 'release_failed' }
  | { id: string; status: 'not_linked'; reason: string };

// Composed from the shared pattern (src/util/uuid.ts); /g finds every id quoted in the brief.
const QUOTED_UUID_RE = new RegExp(`\\b${UUID_PATTERN}\\b`, 'g');
/** Bound on brief-quoted ids looked up, so a brief full of ids cannot fan out reads. */
const MAX_QUOTED_IDS = 5;

/**
 * Resolve the entry this delegation answers.
 *
 * `outbound_entry_id` links an active entry that the target owns or that has no
 * owner. When it cannot be linked, the reason comes back as a report for the
 * result — the delegation itself still goes ahead. Without the input, an id quoted
 * in the brief is linked only when its entry is owned by the target (the same
 * evidence the coordinator's transfer-ownership rule acts on), and only when
 * exactly one quoted id qualifies.
 */
export async function linkOutboundEntry(
  ctx: ToolContext,
  agent: string,
  task: string,
  explicit: unknown,
): Promise<{ link: LinkedOutboundEntry | null; report?: OutboundEntryReport }> {
  const outboundContext = ctx.outboundContext;
  const hasExplicit = typeof explicit === 'string' && explicit.trim().length > 0;
  const entryId = hasExplicit ? (explicit as string).trim() : '';
  const notLinked = (reason: string) => {
    ctx.log.warn({ targetAgent: agent, entryId, reason }, 'delegate: outbound_entry_id not linked — delegating unlinked');
    return { link: null, report: { id: entryId, status: 'not_linked' as const, reason } };
  };
  if (!outboundContext || !ctx.agentRegistry) {
    return hasExplicit ? notLinked('outbound context is not available on this instance') : { link: null };
  }
  const roster: DelegationHintRoster = rosterFromRegistry(ctx.agentRegistry);

  try {
    if (hasExplicit) {
      if (!isUuid(entryId)) {
        return notLinked('not an outbound-context entry id (expected the entry_id UUID from [ACTIVE OUTBOUND CONTEXT])');
      }
      const entry = await outboundContext.getEntry(entryId);
      if (!entry) return notLinked('no active entry with this id (already released or expired)');
      if (isTaskWakeReplyBinding(entry.metadata)) {
        return notLinked('task-wake binding: close it with context-bridge-release and reply instead');
      }
      const owner = delegationHintOwner(entry.delegationHint, roster);
      if (owner && owner !== agent) return notLinked(`entry is owned by ${owner}, not ${agent}`);
      return { link: { entryId, source: 'input' } };
    }

    const quoted = [...new Set(task.match(QUOTED_UUID_RE)?.map(id => id.toLowerCase()) ?? [])].slice(0, MAX_QUOTED_IDS);
    const owned: string[] = [];
    for (const id of quoted) {
      const entry = await outboundContext.getEntry(id);
      if (entry && !isTaskWakeReplyBinding(entry.metadata) && delegationHintOwner(entry.delegationHint, roster) === agent) {
        owned.push(id);
      }
    }
    if (owned.length === 1) {
      ctx.log.info({ targetAgent: agent, entryId: owned[0] }, 'delegate: linked the outbound-context entry quoted in the brief');
      return { link: { entryId: owned[0]!, source: 'task_text' } };
    }
    if (owned.length > 1) {
      ctx.log.warn({ targetAgent: agent, entryIds: owned }, 'delegate: brief quotes several entries the target owns — delegating unlinked');
    }
    return { link: null };
  } catch (err) {
    ctx.log.error({ err, targetAgent: agent }, 'delegate: outbound-context entry lookup failed — delegating unlinked');
    return hasExplicit
      ? { link: null, report: { id: entryId, status: 'not_linked', reason: 'entry lookup failed' } }
      : { link: null };
  }
}

/** Line appended to the specialist's brief naming the entry it is answering. */
export function outboundEntryNote(entryId: string): string {
  return (
    `\n\n[Outbound context] This task answers the principal's reply to outbound-context entry ${entryId}. ` +
    'The platform releases that entry when you return, after which the principal\'s next message no longer routes to you.'
  );
}

/** True when the resume_token cannot be decoded into a usable brief (see the header). */
function resumeTokenUnusable(token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  const payload = decodeResumeToken(token);
  return !payload || !payload.original_task || !payload.context;
}

/** Release or keep the linked entry, from the delegate result (rules in the header). */
export function settlementFor(
  result: ToolResult,
  opts: { taskCreated: boolean; resumeToken: unknown },
): { action: 'release' | 'keep'; why: string } {
  if (!result.success) {
    if (!opts.taskCreated && resumeTokenUnusable(opts.resumeToken)) {
      return { action: 'release', why: 'resume token unusable' };
    }
    return { action: 'keep', why: opts.taskCreated ? 'specialist errored' : 'rejected before dispatch' };
  }
  const data = (result.data ?? {}) as Record<string, unknown>;
  if (data['in_flight'] === true) return { action: 'keep', why: 'specialist already busy' };
  if (data['blocked'] === true) return { action: 'keep', why: 'blocked before dispatch' };
  if (data['failed'] === true && data['retryable'] === true) return { action: 'keep', why: 'retryable failure' };
  if (data['declined'] === true) return { action: 'release', why: 'specialist declined' };
  if (data['failed'] === true) {
    return { action: 'release', why: data['reason'] === 'timeout' ? 'wait timeout (specialist has the reply)' : 'non-retryable failure' };
  }
  return { action: 'release', why: 'specialist handled the reply' };
}

/** Settle the linked entry once the delegation has a result. Never throws. */
export async function settleOutboundEntry(
  ctx: ToolContext,
  link: LinkedOutboundEntry,
  result: ToolResult,
  opts: { delegatedTaskId: string | undefined; resumeToken: unknown },
): Promise<OutboundEntryReport> {
  const { action, why } = settlementFor(result, { taskCreated: opts.delegatedTaskId !== undefined, resumeToken: opts.resumeToken });
  const log = { entryId: link.entryId, linkedVia: link.source, why };
  if (action === 'keep') {
    ctx.log.info(log, 'delegate: reply not handled — outbound-context entry kept active for a retry');
    return { id: link.entryId, status: 'kept' };
  }
  if (!ctx.outboundContext) {
    ctx.log.error(log, 'delegate: outbound context vanished mid-delegation — entry left active');
    return { id: link.entryId, status: 'release_failed' };
  }
  try {
    // With no delegated task (a dead resume rejected before dispatch) there is no
    // keep-open mark to honour; '' matches no task id, so the release is unconditional.
    const outcome = await ctx.outboundContext.releaseUnlessKeptOpen(link.entryId, opts.delegatedTaskId ?? '');
    ctx.log.info({ ...log, outcome }, 'delegate: settled outbound-context entry');
    return { id: link.entryId, status: outcome === 'not_active' ? 'already_released' : outcome };
  } catch (err) {
    ctx.log.error({ ...log, err }, 'delegate: failed to release outbound-context entry — it stays active until expiry');
    return { id: link.entryId, status: 'release_failed' };
  }
}
