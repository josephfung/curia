/**
 * Helpers for dispatcher-relayed outbound replies blocked by the content filter (#1355).
 * When an agent.response is auto-sent via outbound.message and the gateway blocks it,
 * the agent turn is already over — these utilities support a bounded rewrite retry
 * and a salvage-draft fallback on final failure.
 */

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

/** Task body instructing the agent to rewrite a blocked dispatcher-relayed reply. */
export function buildContentBlockRewriteTask(
  blockedContent: string,
  findings: Array<{ rule: string; detail: string }>,
): string {
  const reasonSummary = summarizeBlockFindings(findings);
  const ruleNames = findings.map((f) => f.rule).join(', ');
  return [
    '[OUTBOUND CONTENT FILTER — REWRITE REQUIRED]',
    '',
    'Your previous reply to this conversation was blocked by the outbound content filter before delivery.',
    'Rewrite it and return ONLY the corrected reply text — no preamble, no explanation of the block.',
    '',
    `Block reason: ${reasonSummary}`,
    `Rules triggered: ${ruleNames}`,
    '',
    'Blocked draft:',
    '---',
    blockedContent,
    '---',
    '',
    'Requirements:',
    '- Speak in first person as a single assistant ("I found...", "I checked...").',
    '- Never mention internal specialists, agents, delegation, sub-agents, or internal roles.',
    '- Fix only what caused the block; preserve the intent of the original message.',
  ].join('\n');
}
