// provenance-recording.ts — what a tool call contributes to identifier provenance
// (#2061, #2498, ADR-047). Shared by the agent runtime and the voice bridge, so both
// record the same way.
//
// Before the call: what the agent hands an echo-prone source tool (web-fetch,
// web-browser) is recorded as agent input, under the conversation and, for web-browser,
// under the browser session it drives. After a successful call: the source text of the
// result is recorded under the conversation, minus that agent input. A browser session
// can be reattached from another conversation (keep_warm, a later scheduled run), so
// its own scope carries what was typed into it across conversations.

import type { ExecutionLayer } from '../skills/execution.js';
import type { IdentifierSourceIndex } from './identifier-source-index.js';

type ProvenanceExecution = Pick<ExecutionLayer, 'provenanceSourceText' | 'isAgentEchoSource' | 'provenanceAgentInputText'>;

export interface ProvenanceRecording {
  /** The agent input recorded before the call, or null when the tool takes none. */
  agentInputText: string | null;
  /**
   * True when the call requested a browser session that had no recorded agent input (the
   * record was evicted or expired, or the session was started outside the recorded path,
   * such as an approval replay). Its result cannot be filtered against what was typed
   * there, so it is not recorded as a source at all.
   */
  unrecordedSession: boolean;
}

/** The scope key a browser session's agent input is recorded under. */
export function browserSessionScope(sessionId: string): string {
  return `browser-session:${sessionId}`;
}

function sessionIdOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const id = (value as Record<string, unknown>)['session_id'];
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Record the agent's input to an echo-prone source tool, before the call runs. Throws
 * when it cannot be recorded; the caller must then not count the result as a source
 * (fail closed).
 */
export function recordAgentInputBeforeCall(
  execution: ProvenanceExecution,
  index: IdentifierSourceIndex,
  conversation: string,
  toolName: string,
  input: Record<string, unknown>,
): ProvenanceRecording {
  const agentInputText = execution.provenanceAgentInputText(toolName, input);
  let unrecordedSession = false;
  if (agentInputText) {
    index.recordAgentInput(conversation, agentInputText);
    const sessionId = sessionIdOf(input);
    if (sessionId) {
      // Checked before recording: this call's own input would otherwise make any id look known.
      const scope = browserSessionScope(sessionId);
      unrecordedSession = !index.hasAgentInputScope(scope);
      index.recordAgentInput(scope, agentInputText);
      // The record now starts from this call, so it must not make the session look known later.
      if (unrecordedSession) index.markAgentInputLost(scope);
    }
  }
  return { agentInputText, unrecordedSession };
}

/**
 * Record the source text of a successful result. For an echo-prone tool, agent input
 * recorded under the conversation or the browser session is left out. A call that opened
 * a new browser session (none requested, or the requested one had expired) learns its id
 * only from the result: its own input is recorded under that session first, so later
 * reattachments exclude it too.
 */
export function recordSourceAfterCall(
  execution: ProvenanceExecution,
  index: IdentifierSourceIndex,
  conversation: string,
  toolName: string,
  input: Record<string, unknown>,
  data: unknown,
  before: ProvenanceRecording,
): void {
  const echo = execution.isAgentEchoSource(toolName);
  // Fail closed: earlier typing into this session is unknown, so the page may be echoing it.
  if (echo && before.unrecordedSession) return;
  const scopes = [conversation];
  if (echo) {
    const requested = sessionIdOf(input);
    if (requested) scopes.push(browserSessionScope(requested));
    // The session the call actually ran in. It differs from the one requested when that
    // one had expired and the browser started a fresh session: the input was typed into
    // the new one, so it goes on that session's record too. The id is set by the handler,
    // never by the page.
    const actual = sessionIdOf(data);
    if (actual && actual !== requested) {
      if (before.agentInputText) index.recordAgentInput(browserSessionScope(actual), before.agentInputText);
      scopes.push(browserSessionScope(actual));
    }
  }
  const sourceText = execution.provenanceSourceText(toolName, input, data);
  if (sourceText) index.record(conversation, sourceText, echo ? { excludeAgentInputOf: scopes } : {});
}
