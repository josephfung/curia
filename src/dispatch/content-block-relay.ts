/**
 * Helpers for dispatcher-relayed outbound replies blocked by the content filter (#1355).
 * When an agent.response is auto-sent via outbound.message and the gateway blocks it,
 * the agent turn is already over — these utilities support a bounded rewrite retry
 * and a salvage-draft fallback on final failure. The rewrite prompt also offers
 * NO_REPLY so the agent can abandon send instead of polishing a blocked draft (#1732).
 */

import { NO_REPLY_SENTINEL } from './no-reply.js';
import type { TaskOriginator } from '../contacts/types.js';

/** Maximum rewrite retries after the first content-filter block (2 retries → 3 send attempts). */
export const CONTENT_BLOCK_MAX_RETRIES = 2;

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
      const showDetail = (f.rule.startsWith('llm-judge-') || f.rule === 'disclosure-tier-gate') && f.detail;
      return showDetail ? `${f.rule}: ${f.detail}` : f.rule;
    })
    .join('\n');
}

/** Task body instructing the agent to rewrite a blocked dispatcher-relayed reply, or abandon send. */
export function buildContentBlockRewriteTask(
  blockedContent: string,
  findings: Array<{ rule: string; detail: string }>,
): string {
  const reasonSummary = summarizeBlockFindings(findings);
  const ruleNames = findings.map((f) => f.rule).join(', ');
  const audienceLeak = findings.some((f) => f.rule === 'llm-judge-audience-leak');
  const lines = [
    '[OUTBOUND CONTENT FILTER — REWRITE REQUIRED]',
    '',
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
  ];
  if (audienceLeak) {
    lines.push(
      'This block includes an audience-leak finding: the draft was not appropriate for this',
      `recipient. Prefer ${NO_REPLY_SENTINEL} unless you can rewrite a message that is genuinely for them.`,
      '',
    );
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
