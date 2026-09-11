/**
 * Internal assistant turn persisted after a failed LLM call so working memory
 * stays strictly alternating (user/assistant). The user turn is written *before*
 * the provider call; without this marker the next turn resumes from two
 * consecutive `user` messages and providers that merge them (Anthropic, OpenAI)
 * silently glue the failed prompt onto the new one (#1767).
 *
 * The envelope is distinguishable from a real reply (`_curia_protocol`) but
 * carries the same user-facing error text published on `agent.response`, so
 * LLM context, chat history, and the live error stay in agreement.
 */
export const LLM_FAILURE_PROTOCOL = 'llm_failure';
export const LLM_FAILURE_USER_MESSAGE =
  "I'm sorry, I was unable to process that request. Please try again.";
export const LLM_FAILURE_TURN_CONTENT =
  `{"_curia_protocol":"${LLM_FAILURE_PROTOCOL}","message":${JSON.stringify(LLM_FAILURE_USER_MESSAGE)}}`;

export function parseLlmFailureTurn(content: string): { message: string } | null {
  if (!content.includes(LLM_FAILURE_PROTOCOL)) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (rec['_curia_protocol'] !== LLM_FAILURE_PROTOCOL) return null;
    const message = rec['message'];
    return {
      message: typeof message === 'string' && message.length > 0
        ? message
        : LLM_FAILURE_USER_MESSAGE,
    };
  } catch {
    return null;
  }
}

export function isLlmFailureTurn(turn: { role: string; content: string }): boolean {
  return turn.role === 'assistant' && parseLlmFailureTurn(turn.content) !== null;
}

/**
 * Default working-memory sanitizer: rewrite marker envelopes to the
 * user-facing error text. `WorkingMemory.getHistory` applies this unless
 * the caller passes `{ raw: true }`. Adding a new all-consumer filter
 * rule belongs here — not at individual readers.
 *
 * Consumers that intentionally bypass this (raw protocol envelopes):
 * - `DiagnosticsRepo.getWorkingMemory` — dumps the table verbatim
 * - `AgentRuntime.persistLlmFailureTurn` — pairing check against stored content
 * - storage-inspection tests (`getHistory(..., { raw: true })`)
 *
 * Raw-SQL readers that cannot use `getHistory` must call this explicitly:
 * - `Dispatcher.fireCheckpoint`
 * - `GET /api/kg/chat/history` (via `toChatHistoryMessage`)
 * - working-memory summarization (archive-window transcript)
 */
export function rewriteLlmFailureTurns<T extends { role: string; content: string }>(turns: T[]): T[] {
  return turns.map((turn) => {
    const parsed = turn.role === 'assistant' ? parseLlmFailureTurn(turn.content) : null;
    if (!parsed) return turn;
    return { ...turn, content: parsed.message };
  });
}

/**
 * History that is safe to send to an LLM provider.
 *
 * Rewrite of failure markers is also the `getHistory` default (#1775); this
 * helper still rewrites so it is correct when given raw turns. The collapse
 * and trailing-user drop stay here — they are LLM-assembly only and must not
 * be the `getHistory` default (chat history has to render the latest user turn).
 *
 * 1. Rewrites failure markers to the user-facing error text so the failed
 *    question stays in context (paired with an assistant turn, not glued).
 * 2. Collapses consecutive same-role user/assistant turns anywhere in the
 *    array, keeping the later one — heals mid-history orphans from crash /
 *    silent-stop / failed-marker-persist paths.
 * 3. Drops trailing `user` turns that have no assistant reply yet. The runtime
 *    appends the current user separately.
 */
export function historyForLlm<T extends { role: string; content: string }>(turns: T[]): T[] {
  const out: T[] = [];
  for (const turn of rewriteLlmFailureTurns(turns)) {
    if (turn.role !== 'system') {
      const last = out[out.length - 1];
      if (last && last.role === turn.role) {
        out.pop();
      }
    }
    out.push(turn);
  }
  while (out.length > 0 && out[out.length - 1]!.role === 'user') {
    out.pop();
  }
  return out;
}
