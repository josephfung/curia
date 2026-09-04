/**
 * Explicit no-reply sentinel for dispatcher-relayed agent responses (#1732).
 *
 * An agent's entire response content matching this token means "send nothing":
 * handleAgentResponse publishes outbound.no_reply instead of outbound.message.
 * Used on a normal turn (the agent concludes nothing should go out) and on the
 * content-block rewrite path (the agent abandons a blocked draft instead of
 * polishing it into a deliverable acknowledgement).
 */

/** Exact token the agent returns as its entire response to decline outbound delivery. */
export const NO_REPLY_SENTINEL = 'NO_REPLY';

/**
 * True when `content` is the no-reply sentinel and nothing else.
 *
 * Accepts surrounding whitespace and a single layer of matching quotes or
 * backticks so a slightly messy model still hits the hatch. Additional prose
 * is a real reply and will be sent — narration like "I'll just archive it"
 * must not be smuggled through as silence.
 */
export function isNoReplyContent(content: string): boolean {
  let s = content.trim();
  if (s.length >= 2) {
    const first = s[0]!;
    const last = s[s.length - 1]!;
    if ((first === '`' || first === '"' || first === "'") && first === last) {
      s = s.slice(1, -1).trim();
    }
  }
  return s.toUpperCase() === NO_REPLY_SENTINEL;
}
