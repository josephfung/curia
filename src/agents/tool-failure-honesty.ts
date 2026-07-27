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

/** Stable fingerprint so success for input B does not clear a failure for input A. */
export function fingerprintToolInvocation(
  toolName: string,
  input: Record<string, unknown>,
): string {
  return `${toolName}:${stableJson(input)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
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
 *
 * Mixed replies that both admit failure *and* claim the action landed
 * (e.g. "I couldn't dismiss it, but I've noted the dismissal") still count
 * as unacknowledged success — failure words alone are not enough.
 */
export function looksLikeUnacknowledgedSuccess(reply: string): boolean {
  const text = reply.trim();
  if (!text) return false;
  const affirms =
    /\b(got it|noted|done|dismissed|confirmed|completed|all set|taken care of|i('ve| have) (noted|done|dismissed|confirmed|completed)|successfully)\b/i.test(
      text,
    );
  if (!affirms) return false;
  const acknowledgesFailure =
    /\b(couldn'?t|could not|wasn'?t able|unable|failed|failure|error|didn'?t (work|succeed|go through)|not (able|found|successful)|try again|could not (find|complete)|no actionable)\b/i.test(
      text,
    );
  if (!acknowledgesFailure) return true;
  // Failure language present, but a later "but … noted/done/dismissed" still
  // claims the blocked action succeeded — treat as dishonest.
  return /\bbut\b[\s\S]{0,80}\b(noted|got it|done|dismissed|confirmed|completed|successfully)\b/i.test(
    text,
  );
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
