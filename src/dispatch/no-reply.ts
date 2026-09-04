/**
 * Explicit no-reply sentinel for dispatcher-relayed agent responses (#1732).
 *
 * An agent's entire response content matching this token means "send nothing":
 * handleAgentResponse publishes outbound.no_reply instead of outbound.message.
 * Used on a normal turn (the agent concludes nothing should go out) and on the
 * content-block rewrite path (the agent abandons a blocked draft instead of
 * polishing it into a deliverable acknowledgement).
 *
 * Matching fails toward silence: a near-miss that starts with the token, or a
 * body that contains it as a standalone word, is treated as an ambiguous decline
 * rather than emailed to an external contact. See #1732 review.
 */

/** Exact token the agent returns as its entire response to decline outbound delivery. */
export const NO_REPLY_SENTINEL = 'NO_REPLY';

const SENTINEL_HEAD = new RegExp(`^${NO_REPLY_SENTINEL}\\b`, 'i');
const STANDALONE_SENTINEL = new RegExp(`\\b${NO_REPLY_SENTINEL}\\b`, 'i');

export type NoReplyClassification = 'exact' | 'ambiguous' | 'empty';

/**
 * Classify response text for the dispatcher relay.
 *
 * - `empty` — whitespace only (a non-message; do not deliver a blank body)
 * - `exact` — the whole content is the sentinel after unwrap / trailing punctuation
 * - `ambiguous` — content starts with the sentinel as a token but has extra prose
 * - `null` — a real reply (subject to the standalone-token send guard)
 */
export function classifyNoReply(content: string): NoReplyClassification | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 'empty';

  const core = stripTrailingPunct(unwrapOuter(trimmed));
  if (core.toUpperCase() === NO_REPLY_SENTINEL) return 'exact';

  if (SENTINEL_HEAD.test(trimmed) || SENTINEL_HEAD.test(unwrapOuter(trimmed))) {
    return 'ambiguous';
  }
  return null;
}

/** True when the entire response is the no-reply sentinel (exact match only). */
export function isNoReplyContent(content: string): boolean {
  return classifyNoReply(content) === 'exact';
}

/**
 * True when `content` contains `NO_REPLY` as a standalone token. Used as a
 * send-path guard so a missed classification cannot deliver the control token.
 */
export function containsStandaloneNoReplyToken(content: string): boolean {
  return STANDALONE_SENTINEL.test(content);
}

export interface PreparedAgentResponse {
  content: string;
  suppressDelivery: boolean;
}

/**
 * Runtime-side preparation: lift the sentinel out of `content` before publish
 * so scheduler summaries and working-memory turns do not store a control token.
 * Exact matches are blanked; ambiguous near-misses keep the raw text so dispatch
 * can salvage a draft.
 */
export function prepareAgentResponseContent(raw: string): PreparedAgentResponse {
  const kind = classifyNoReply(raw);
  if (kind === 'exact') {
    return { content: '', suppressDelivery: true };
  }
  if (kind === 'ambiguous') {
    return { content: raw, suppressDelivery: true };
  }
  return { content: raw, suppressDelivery: false };
}

function unwrapOuter(s: string): string {
  let t = s.trim();
  if (t.startsWith('```') && t.endsWith('```') && t.length >= 6) {
    t = t.slice(3, -3).trim();
    const firstLine = t.split('\n', 1)[0] ?? '';
    if (/^[A-Za-z0-9_-]+$/.test(firstLine) && firstLine.toUpperCase() !== NO_REPLY_SENTINEL) {
      t = t.slice(firstLine.length).replace(/^\n/, '').trim();
    }
  }
  if (t.length >= 2) {
    const first = t[0]!;
    const last = t[t.length - 1]!;
    if ((first === '`' || first === '"' || first === "'") && first === last) {
      t = t.slice(1, -1).trim();
    }
  }
  return t;
}

function stripTrailingPunct(s: string): string {
  return s.replace(/[.!?]+$/u, '').trim();
}
