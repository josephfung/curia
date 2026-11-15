/**
 * Helpers for dispatcher-relayed outbound replies blocked by the content filter (#1355).
 * When an agent.response is auto-sent via outbound.message and the gateway blocks it,
 * the agent turn is already over — these utilities support a bounded rewrite retry
 * and a salvage-draft fallback on final failure. The rewrite prompt also offers
 * NO_REPLY so the agent can abandon send instead of polishing a blocked draft (#1732).
 */

import { NO_REPLY_SENTINEL } from './no-reply.js';
import { CONTENT_BLOCK_REWRITE_MARKER } from '../memory/synthetic-user-turn.js';
import type { TaskOriginator } from '../contacts/types.js';
import type { LinkedTaskMeta } from './dispatcher.js';
import type { AuditLogRow } from '../audit/audit-log-repo.js';
import { redactSecrets, renderResult } from '../autonomy/send-evidence.js';
import {
  MAX_PRIOR_TURN_CALLS,
  MAX_PRIOR_TURN_FIELD,
  MAX_PRIOR_TURN_SENT,
  renderPriorTurnCall,
  type PriorTurnActions,
  type PriorTurnCall,
  type PriorTurnNotSent,
} from '../agents/prompts/prior-turn-actions.js';
import { NOTHING_SENT_NEXT_STEP } from '../agents/prompts/delegate-result-guidance.js';

/** Maximum rewrite retries after the first content-filter block (2 retries → 3 send attempts). */
export const CONTENT_BLOCK_MAX_RETRIES = 2;

/**
 * Tool results read for the drafting turn (#2615). The read asks for one more, so it can tell
 * the rewrite that older calls exist beyond this limit. The repo returns the newest first.
 */
export const PRIOR_TURN_RESULTS_LIMIT = MAX_PRIOR_TURN_CALLS;
/** Per result, in code points, like the send review's evidence but tighter: it goes in every rewrite. */
export const PRIOR_TURN_RESULT_MAX_CHARS = 1_500;
/**
 * All calls' rendered lines together, in code points, escaping included. The calls closest to
 * the draft are kept.
 */
export const PRIOR_TURN_TOTAL_MAX_CHARS = 8_000;

/** Rules that indicate a recipient/config problem — rewriting the body cannot fix these. */
const TERMINAL_BLOCK_RULES = new Set(['no-reply-recipient', 'filter-error', 'pii_redactor_error']);

export interface RelayOutboundContext {
  agentId: string;
  conversationId: string;
  channelId: string;
  senderId: string;
  accountId?: string;
  taskEventId: string;
  content: string;
  contentBlockRetryAttempt: number;
  liveTurn?: boolean;
  /** Propagated so rewrite retries still enforce Gate C (#1733). */
  originator?: TaskOriginator;
  /** The note queued for the principal with the first reply: evidence for the rewrite's review (#2312). */
  reportedToPrincipal?: string;
  /** The reply's outreach link, so the rewrite's review sees the same authority as the first (#2192). */
  linkedTask?: LinkedTaskMeta;
  /**
   * What the first drafting turn did, read once and carried to later rewrites (#2615).
   * Rewrite turns have no tools, so the first turn is the only one with anything to show.
   */
  priorTurnActions?: PriorTurnActions;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

/**
 * Trim from the middle, by code point, so both ends survive and no surrogate pair is split:
 * a lone surrogate in the task payload would fail its jsonb audit write and lose the reply.
 * A specialist's conclusion is usually at the end of its answer, its headline at the start.
 */
export function clipMiddleCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  const marker = (n: number): string => `\n[… ${n} characters left out …]\n`;
  // Sized for the worst-case count, so the result fits `max`; then the true count is written.
  const keep = Math.max(0, max - Array.from(marker(points.length)).length);
  const head = Math.ceil(keep / 2);
  return `${points.slice(0, head).join('')}${marker(points.length - keep)}${points.slice(points.length - (keep - head)).join('')}`;
}

/**
 * One tool.result audit row as the rewrite reads it. The outcome is claimed only on positive
 * evidence: a row that records neither (a legacy row, or one whose outcome could not be
 * extracted) is `unknown`, so the rewrite never tells a recipient something was done when
 * nobody knows. A delegated call shows the specialist and what it sent ahead of the excerpt,
 * so trimming a long answer cannot drop them.
 *
 * A specialist's prose can call an email sent when it only composed one (#2055). The delegate
 * result records that beside the prose (shapeSpecialistAnswer): an empty `sent` list, the
 * composed drafts, and a next_step. The list is kept even when empty, and the drafts or the
 * nothing-sent next_step become `notSent`, so the rewrite never has only the prose to go on.
 * No delegate result's next_step is carried, whatever its shape: those say what the calling
 * agent should do next (send with email-send, try the step itself), and this turn has no tools.
 *
 * A delegation that did not finish still reports `success: true`, so the skill's flag is not the
 * outcome. Its data says what happened: `failed` (a decline, a blocked re-delegation, a
 * structured failure) is failed; a timeout that may have gone through, a paused task, a
 * question back, and work still running or interrupted are unknown, never claimed as done.
 */
function priorTurnCall(row: AuditLogRow): PriorTurnCall {
  const tool = clipMiddleCodePoints(String(row.payload['toolName'] ?? row.payload['skillName'] ?? 'unknown'), MAX_PRIOR_TURN_FIELD);
  const result = asRecord(row.payload['result']);
  const data = asRecord(result?.['data']);
  const isDelegate = tool === 'delegate';
  const outcome: PriorTurnCall['outcome'] = row.outcome === 'failure' || result?.['success'] === false
    ? 'failed'
    : isDelegate && delegateUnfinished(data) ? 'unknown'
    : isDelegate && (data?.['failed'] === true || data?.['declined'] === true) ? 'failed'
    : row.outcome === 'success' || result?.['success'] === true ? 'succeeded' : 'unknown';
  const agent = typeof data?.['agent'] === 'string' && data['agent'] !== ''
    ? clipMiddleCodePoints(data['agent'], MAX_PRIOR_TURN_FIELD)
    : undefined;
  // Capped at what the parser accepts; past that, the account would be refused whole.
  const sent = Array.isArray(data?.['sent'])
    ? (data['sent'] as unknown[])
      .filter((s): s is string => typeof s === 'string' && s !== '')
      .slice(0, MAX_PRIOR_TURN_SENT)
      .map((s) => clipMiddleCodePoints(s, MAX_PRIOR_TURN_FIELD))
    : undefined;
  const notSent: PriorTurnNotSent | undefined = tool !== 'delegate' ? undefined
    : Array.isArray(data?.['draft_emails']) && data['draft_emails'].length > 0 ? 'draft'
    : data?.['next_step'] === NOTHING_SENT_NEXT_STEP ? 'nothing'
    : undefined;
  // A specialist's answer is prose: show it as text rather than escaped inside JSON. Only for
  // delegate, whose other fields are lifted above; another tool's `response` field is one field
  // among others (an event id, say), so its whole result is shown.
  const response = isDelegate && typeof data?.['response'] === 'string' ? data['response'] : undefined;
  const error = typeof result?.['error'] === 'string' ? result['error'] : undefined;
  const raw = response !== undefined ? redactSecrets(response)
    : error !== undefined ? redactSecrets(error)
    : isDelegate && data !== undefined ? redactSecrets(JSON.stringify(delegateFacts(data)))
    : renderResult(row.payload);
  return {
    tool,
    outcome,
    ...(agent ? { agent } : {}),
    ...(sent ? { sent } : {}),
    ...(notSent ? { notSent } : {}),
    excerpt: clipMiddleCodePoints(raw, PRIOR_TURN_RESULT_MAX_CHARS),
  };
}

/** A delegation whose work may or may not have happened: never claimed as done or as failed. */
function delegateUnfinished(data: Record<string, unknown> | undefined): boolean {
  return data?.['possibly_succeeded'] === true
    || data?.['in_flight'] === true
    || data?.['in_progress'] === true
    || data?.['paused'] === true
    || data?.['needs_clarification'] === true;
}

/**
 * What a delegate result with no answer text says happened, as the rewrite reads it: a decline,
 * a blocked or failed delegation, a pause, a question back, work still running. Listed field by
 * field, so a field that tells the calling agent what to do (next_step) or carries something
 * to send (draft_emails) or resume (resume_token) is never passed on, nor is a new one added
 * later. `agent` and `sent` are lifted onto the call.
 */
const DELEGATE_FACT_KEYS = [
  'declined', 'failed', 'blocked', 'possibly_succeeded', 'in_flight', 'in_progress', 'paused',
  'needs_clarification', 'reason', 'cause', 'message', 'question', 'done', 'total', 'next',
  'work_product',
] as const;

function delegateFacts(data: Record<string, unknown>): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const key of DELEGATE_FACT_KEYS) {
    if (data[key] !== undefined) facts[key] = data[key];
  }
  return facts;
}

/**
 * The drafting turn's tool calls as the rewrite reads them (#2615), oldest first. `rows` are
 * tool.result audit rows, newest first as `AuditLogRepo.findToolResultsForTasks` returns them,
 * read with a limit of PRIOR_TURN_RESULTS_LIMIT + 1: a full read means older calls exist. The
 * calls closest to the draft are kept when the total runs over, and the rest are counted.
 */
export function priorTurnActionsFromRows(rows: readonly AuditLogRow[]): PriorTurnActions {
  const moreBeforeLimit = rows.length > PRIOR_TURN_RESULTS_LIMIT;
  const considered = rows.slice(0, PRIOR_TURN_RESULTS_LIMIT);
  const kept: PriorTurnCall[] = [];
  let total = 0;
  for (const row of considered) {
    const call = priorTurnCall(row);
    // The rendered line, so JSON escaping (a result that is itself JSON doubles its quotes)
    // and every lifted field count against the budget, plus its line break.
    const size = Array.from(renderPriorTurnCall(call)).length + 1;
    if (total + size > PRIOR_TURN_TOTAL_MAX_CHARS) break;
    total += size;
    kept.push(call);
  }
  return {
    status: 'read',
    calls: kept.reverse(),
    earlierLeftOut: considered.length - kept.length,
    moreBeforeLimit,
  };
}

/** Whether the block reason is fixable by rewriting the message body. */
export function isContentFilterRewriteable(findings: Array<{ rule: string; detail: string }>): boolean {
  if (findings.length === 0) return false;
  return findings.every((f) => !TERMINAL_BLOCK_RULES.has(f.rule));
}

/** Principal-safe summary for the rewrite task — mirrors outbound-gateway policy. */
export function summarizeBlockFindings(findings: Array<{ rule: string; detail: string }>): string {
  if (findings.length === 0) return 'Content filter (no rule detail available)';
  return findings
    .map((f) => {
      // A band bounce quotes the agent's own sentences, which it needs to fix the reply (#2159).
      // The PII and placeholder findings name labels only, never values (#2312).
      // The identity gate names the words from the agent's own draft it could not resolve, and
      // says to rephrase a product or place name (#2615): a rewrite with no tools can fix the
      // draft only if it is told which word. The send skills already return this detail.
      const showDetail = (
        f.rule.startsWith('llm-judge-')
        || f.rule === 'disclosure-tier-gate'
        || f.rule === 'ungrounded-claim'
        || f.rule === 'unneeded-disclosure'
        || f.rule === 'pii-not-authorized'
        || f.rule === 'redaction-token'
        || f.rule === 'unresolved-identity'
      ) && f.detail;
      return showDetail ? `${f.rule}: ${f.detail}` : f.rule;
    })
    .join('\n');
}

/**
 * The rewrite brief's fixed instruction lines. A rewrite turn's answer is the reply itself, so
 * these are registered as prompt-exfiltration marker sources (trigger-guidance-sources.ts):
 * an echo of them to the recipient is blocked like an echo of the system prompt.
 */
export const CONTENT_BLOCK_REWRITE_INSTRUCTION_LINES: readonly string[] = [
  'Your previous reply was blocked before delivery. You have two options:',
  '',
  '1. Rewrite it to satisfy the findings below, applying your normal audience and voice rules.',
  '   Return ONLY the corrected reply text — no preamble about the block.',
  '',
  `2. Return exactly ${NO_REPLY_SENTINEL} (and nothing else) if this message should not have been`,
  '   addressed to this recipient at all — for example an audience-leak finding, an automated',
  '   notification that needs no acknowledgement, or anything whose correct outcome is silence.',
  `   ${NO_REPLY_SENTINEL} abandons delivery: no send, no salvage draft, no further retry.`,
  '',
  // #2615: the dispatcher sends this turn with an empty tool allowlist. What the turn already
  // did reaches the prompt separately (agents/prompts/prior-turn-actions.ts), never this brief.
  'This turn edits the draft only, so it has no tools.',
  // The identity gate's detail suggests the contacts specialist, which this turn cannot reach.
  'Where a finding says to look something up or resolve someone, rephrase or leave that part out.',
];

/** Added to the brief for an audience-leak finding. A marker source too. */
export const AUDIENCE_LEAK_REWRITE_LINES: readonly string[] = [
  'This block includes an audience-leak finding: the draft was not appropriate for this',
  `recipient. Prefer ${NO_REPLY_SENTINEL} unless you can rewrite a message that is genuinely for them.`,
];

/**
 * Task body instructing the agent to rewrite a blocked dispatcher-relayed reply, or abandon send.
 * It is stored in working memory, so it carries no tool output: the drafting turn's account
 * travels on the task's `priorTurnActions` field and is rendered into this turn's prompt only.
 */
export function buildContentBlockRewriteTask(
  blockedContent: string,
  findings: Array<{ rule: string; detail: string }>,
): string {
  const reasonSummary = summarizeBlockFindings(findings);
  const ruleNames = findings.map((f) => f.rule).join(', ');
  const audienceLeak = findings.some((f) => f.rule === 'llm-judge-audience-leak');
  const lines = [
    // Registered in synthetic-user-turn.ts so contact recall and the sender
    // backfill can tell this apart from a human message (#1892).
    CONTENT_BLOCK_REWRITE_MARKER,
    '',
    ...CONTENT_BLOCK_REWRITE_INSTRUCTION_LINES,
    '',
  ];
  if (audienceLeak) {
    lines.push(...AUDIENCE_LEAK_REWRITE_LINES, '');
  }
  lines.push(
    `Block reason: ${reasonSummary}`,
    `Rules triggered: ${ruleNames}`,
    '',
    'Blocked draft:',
    '---',
    blockedContent,
    '---',
  );
  return lines.join('\n');
}
