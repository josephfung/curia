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
/** The marker envelope carrying a specific user-facing failure message. */
export function llmFailureTurnContent(message: string): string {
  return `{"_curia_protocol":"${LLM_FAILURE_PROTOCOL}","message":${JSON.stringify(message)}}`;
}
export const LLM_FAILURE_TURN_CONTENT = llmFailureTurnContent(LLM_FAILURE_USER_MESSAGE);

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
 *    A user row followed by one or more `injected` user rows is a group
 *    (#2018): the rows stay in order. A later non-injected user row replaces
 *    the whole group. One-row pop would leave the anchor user orphaned
 *    beside the new question, and providers that merge same-role turns would
 *    glue the previous turn's text onto the new one.
 * 3. Drops trailing `user` turns that have no assistant reply yet, including
 *    a trailing injected group. The runtime appends the current user separately.
 */
export function historyForLlm<T extends { role: string; content: string; injected?: true }>(turns: T[]): T[] {
  const out: T[] = [];
  for (const turn of rewriteLlmFailureTurns(turns)) {
    if (turn.role !== 'system') {
      const last = out[out.length - 1];
      if (last && last.role === turn.role) {
        // An injected user row joins the preceding user row. It does not
        // replace it. Any other same-role row replaces the group.
        const keepsGroup = turn.role === 'user' && turn.injected === true;
        if (!keepsGroup) {
          if (turn.role === 'user') {
            while (
              out.length > 0
              && out[out.length - 1]!.role === 'user'
              && out[out.length - 1]!.injected === true
            ) {
              out.pop();
            }
          }
          if (out.length > 0 && out[out.length - 1]?.role === turn.role) {
            out.pop();
          }
        }
      }
    }
    out.push(turn);
  }
  while (out.length > 0 && out[out.length - 1]!.role === 'user') {
    out.pop();
  }
  return out;
}

export type LlmFailurePairing =
  | { ok: true }
  | { ok: false; reason: 'not_user' | 'content_mismatch' };

/**
 * Whether the tail of raw history is the user message this task wrote.
 *
 * A trailing run of injected follow-ups is part of that same turn (#2018),
 * so the check looks through them to the anchor user row. The injected
 * rows' own text is never the anchor: pairing on it would mark a failure
 * against a follow-up instead of the question that failed.
 *
 * `not_user` — the tail (after that run) is not a user row. Callers stay quiet.
 * `content_mismatch` — a different user row is last. Callers warn and skip.
 */
export function llmFailurePairing<T extends { role: string; content: string; injected?: true }>(
  history: readonly T[],
  expectedUserContent: string,
): LlmFailurePairing {
  let index = history.length - 1;
  while (index >= 0 && history[index]?.role === 'user' && history[index]?.injected === true) {
    index -= 1;
  }
  const anchor = index >= 0 ? history[index] : undefined;
  if (anchor?.role !== 'user' || anchor.injected === true) {
    return { ok: false, reason: 'not_user' };
  }
  if (anchor.content !== expectedUserContent) {
    return { ok: false, reason: 'content_mismatch' };
  }
  return { ok: true };
}
