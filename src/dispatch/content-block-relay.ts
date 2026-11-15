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
import { renderResult } from '../autonomy/send-evidence.js';

/** Maximum rewrite retries after the first content-filter block (2 retries → 3 send attempts). */
export const CONTENT_BLOCK_MAX_RETRIES = 2;

/**
 * What the blocked reply's turn already did (#2615). The rewrite turn has no tools and no
 * other record of that turn's tool calls: working memory keeps message text only. Without
 * this section a rewrite re-planned a reply whose turn had already booked a meeting, and
 * told the guest it would check first.
 */
export const PRIOR_TURN_ACTIONS_HEADING = 'What your previous turn already did';
/** Tool results read for that turn. The repo returns the newest first. */
export const PRIOR_TURN_RESULTS_LIMIT = 40;
/** Per result, like the send review's evidence (EVIDENCE_RESULT_MAX_CHARS) but tighter: this goes in every rewrite. */
export const PRIOR_TURN_RESULT_MAX_CHARS = 1_500;
/** All results together. The calls closest to the draft are kept. */
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
   * What the first drafting turn did, rendered once by {@link renderPriorTurnActions} and
   * carried to later rewrites (#2615). Rewrite turns have no tools, so the first turn is
   * the only one with anything to show.
   */
  priorTurnActions?: string;
}

/**
 * The drafting turn's tool calls as the rewrite reads them (#2615), oldest first, each marked
 * succeeded or failed. `rows` are tool.result audit rows, newest first as
 * `AuditLogRepo.findToolResultsForTasks` returns them. The calls closest to the draft are
 * kept when the total runs over. Credentials are redacted: the brief is stored in working
 * memory and the audit log. Null when the turn called no tools.
 */
export function renderPriorTurnActions(rows: readonly AuditLogRow[]): string | null {
  if (rows.length === 0) return null;
  const kept: string[] = [];
  let total = 0;
  for (const row of rows) {
    const toolName = String(row.payload['toolName'] ?? row.payload['skillName'] ?? 'unknown');
    const result = row.payload['result'];
    // The outcome column is null on legacy rows; the result's own flag then decides.
    const failed = row.outcome === 'failure'
      || (typeof result === 'object' && result !== null && (result as Record<string, unknown>)['success'] === false);
    const text = clip(renderResult(row.payload), PRIOR_TURN_RESULT_MAX_CHARS);
    const line = `- ${toolName} (${failed ? 'failed' : 'succeeded'}): ${text}`;
    if (total + line.length > PRIOR_TURN_TOTAL_MAX_CHARS) break;
    total += line.length;
    kept.push(line);
  }
  const leftOut = rows.length - kept.length;
  const lines = kept.reverse();
  if (leftOut > 0) {
    lines.unshift(`(${leftOut} earlier ${leftOut === 1 ? 'call' : 'calls'} left out)`);
  }
  return lines.join('\n');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
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
      const showDetail = (
        f.rule.startsWith('llm-judge-')
        || f.rule === 'disclosure-tier-gate'
        || f.rule === 'ungrounded-claim'
        || f.rule === 'unneeded-disclosure'
        || f.rule === 'pii-not-authorized'
        || f.rule === 'redaction-token'
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
  // #2615: the dispatcher sends this turn with an empty tool allowlist.
  'This turn edits the draft only, so it has no tools.',
];

/** Heads {@link renderPriorTurnActions}'s list in the brief (#2615). A marker source too. */
export const PRIOR_TURN_ACTIONS_INTRO = `${PRIOR_TURN_ACTIONS_HEADING} (its tool calls, oldest first). Keep the reply true to them:`;

/** Added to the brief for an audience-leak finding. A marker source too. */
export const AUDIENCE_LEAK_REWRITE_LINES: readonly string[] = [
  'This block includes an audience-leak finding: the draft was not appropriate for this',
  `recipient. Prefer ${NO_REPLY_SENTINEL} unless you can rewrite a message that is genuinely for them.`,
];

/**
 * Task body instructing the agent to rewrite a blocked dispatcher-relayed reply, or abandon send.
 * `priorTurnActions` is {@link renderPriorTurnActions}'s account of the drafting turn (#2615).
 */
export function buildContentBlockRewriteTask(
  blockedContent: string,
  findings: Array<{ rule: string; detail: string }>,
  priorTurnActions?: string,
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
  if (priorTurnActions) {
    lines.push(PRIOR_TURN_ACTIONS_INTRO, priorTurnActions, '');
  }
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
