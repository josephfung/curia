/**
 * Internal assistant turn persisted after a failed LLM call so working memory
 * stays strictly alternating (user/assistant). The user turn is written *before*
 * the provider call; without this marker the next turn resumes from two
 * consecutive `user` messages and providers that merge them (Anthropic, OpenAI)
 * silently glue the failed prompt onto the new one (#1767).
 *
 * Distinguishable from a real reply: console history and LLM context both
 * filter these turns. Never replayed to the principal as something Curia said.
 */
export const LLM_FAILURE_PROTOCOL = 'llm_failure';
export const LLM_FAILURE_TURN_CONTENT = `{"_curia_protocol":"${LLM_FAILURE_PROTOCOL}"}`;

export function isLlmFailureTurn(turn: { role: string; content: string }): boolean {
  return turn.role === 'assistant' && turn.content === LLM_FAILURE_TURN_CONTENT;
}

export function isLlmFailureTurnContent(content: string): boolean {
  return content === LLM_FAILURE_TURN_CONTENT;
}

/**
 * Drop (user, llm_failure marker) pairs and stray markers.
 * Used by summarization so the protocol JSON never enters a condensed transcript.
 */
export function omitLlmFailurePairs<T extends { role: string; content: string }>(turns: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const next = turns[i + 1];
    if (turn.role === 'user' && next && isLlmFailureTurn(next)) {
      i++;
      continue;
    }
    if (isLlmFailureTurn(turn)) {
      continue;
    }
    out.push(turn);
  }
  return out;
}

/**
 * History that is safe to send to an LLM provider.
 *
 * 1. Drops failed-call pairs so the failed user text is not replayed (and cannot
 *    be glued onto the next user message by a lenient provider).
 * 2. Drops trailing `user` turns that have no assistant reply yet — those are
 *    either the in-flight persist (runtime appends the current user separately)
 *    or a pre-fix orphan. Either way they must not precede the new user turn.
 */
export function historyForLlm<T extends { role: string; content: string }>(turns: T[]): T[] {
  const withoutFailures = omitLlmFailurePairs(turns);
  const out = [...withoutFailures];
  while (out.length > 0 && out[out.length - 1]!.role === 'user') {
    out.pop();
  }
  return out;
}
