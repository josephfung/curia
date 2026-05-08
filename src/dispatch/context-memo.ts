// src/dispatch/context-memo.ts
//
// Pure functions for outbound context memos on non-threaded channels.
// The dispatch layer writes memos to working memory on outbound and reads them
// on inbound. These functions format, parse, and assemble memo content without
// any dependency on the bus, database, or working memory service.
//
// See docs/wip/2026-05-08-non-threaded-context-bridging-design.md

import type { ConversationTurn } from '../memory/working-memory.js';

/** Prefix that identifies outbound context memos in working memory turns. */
export const OUTBOUND_MEMO_PREFIX = '[OUTBOUND CONTEXT — ';

const MAX_PREVIEW_LENGTH = 200;

interface FormatMemoInput {
  conversationId: string;
  content: string;
  taskEventId: string | undefined;
}

/**
 * Format an outbound context memo as a structured text string.
 * Written to working memory as a system-role turn so the coordinator
 * can see what it last sent on a non-threaded channel.
 */
export function formatOutboundMemo(input: FormatMemoInput): string {
  const timestamp = new Date().toISOString();
  const preview = input.content.length > MAX_PREVIEW_LENGTH
    ? input.content.slice(0, MAX_PREVIEW_LENGTH) + '…'
    : input.content;

  const lines = [
    `${OUTBOUND_MEMO_PREFIX}${timestamp}]`,
    `source_conversation: ${input.conversationId}`,
    `message_preview: ${preview}`,
    `task_type: coordinator-response`,
  ];

  if (input.taskEventId) {
    lines.push(`key_ids: task:${input.taskEventId}`);
  }

  lines.push('expected_reply: User may reply to this message');

  return lines.join('\n');
}

/**
 * Extract outbound context memos from a working memory turn history.
 * Filters to system-role turns with the memo prefix whose embedded
 * timestamp is within the TTL window.
 *
 * Returns memos in the same order they appear in `turns` (chronological,
 * since working memory returns oldest-first).
 */
export function extractRecentMemos(
  turns: ConversationTurn[],
  ttlMs: number,
): string[] {
  const cutoff = Date.now() - ttlMs;

  return turns.filter((turn) => {
    if (turn.role !== 'system') return false;
    if (!turn.content.startsWith(OUTBOUND_MEMO_PREFIX)) return false;

    // Parse timestamp from the prefix line: [OUTBOUND CONTEXT — <ISO timestamp>]
    const closingBracket = turn.content.indexOf(']');
    if (closingBracket === -1) return false;
    const timestamp = turn.content.slice(OUTBOUND_MEMO_PREFIX.length, closingBracket);
    const memoTime = new Date(timestamp).getTime();
    if (isNaN(memoTime)) return false;

    return memoTime >= cutoff;
  }).map(turn => turn.content);
}

/**
 * Build the context preamble that the dispatcher prepends to inbound task content.
 * Returns null if no memos are provided (caller should use original content as-is).
 */
export function buildContextPreamble(
  memos: string[],
  originalContent: string,
): string | null {
  if (memos.length === 0) return null;

  const memoBlock = memos.map(m => `---\n${m}\n---`).join('\n');

  return [
    '[PRIOR OUTBOUND CONTEXT — this is what you last sent on this channel]',
    memoBlock,
    '',
    originalContent,
  ].join('\n');
}
