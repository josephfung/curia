/**
 * Tool-failure honesty helpers (#1546).
 *
 * After a tool-using turn that recorded one or more unresolved failures, the
 * final natural-language reply must not claim those actions succeeded. The
 * outbound Stage-2 LLM judge skips principal-only recipients, so this runs in
 * AgentRuntime before `agent.response` is published — same family as empty-text
 * recovery and the #1171 delegation short-circuit.
 */

export interface UnresolvedToolFailure {
  toolName: string;
  /** Raw skill error string (may include <skill_error> wrappers). */
  message: string;
}

/** Strip skill/XML wrappers so the principal sees plain language. */
export function humanizeToolFailureMessage(message: string): string {
  return message
    .replace(/<\/?skill_error>/gi, '')
    .replace(/<\/?task_error>/gi, '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Heuristic: reply affirms completion without acknowledging failure.
 * Conservative — only triggers when both sides match; ambiguous replies pass.
 */
export function looksLikeUnacknowledgedSuccess(reply: string): boolean {
  const text = reply.trim();
  if (!text) return false;
  const affirms =
    /\b(got it|noted|done|dismissed|confirmed|completed|all set|taken care of|i('ve| have) (noted|done|dismissed|confirmed|completed)|successfully)\b/i.test(
      text,
    );
  const acknowledgesFailure =
    /\b(couldn'?t|could not|wasn'?t able|unable|failed|failure|error|didn'?t (work|succeed|go through)|not (able|found|successful)|try again|could not (find|complete)|no actionable)\b/i.test(
      text,
    );
  return affirms && !acknowledgesFailure;
}

/** Deterministic honest reply when the model claimed success after tool failures. */
export function buildUnresolvedFailureReply(failures: UnresolvedToolFailure[]): string {
  const details = failures
    .map((f) => {
      const clean = humanizeToolFailureMessage(f.message);
      return clean ? clean : `${f.toolName} failed`;
    })
    .join('; ');
  return `I wasn't able to complete that — ${details}. Want me to try again?`;
}
