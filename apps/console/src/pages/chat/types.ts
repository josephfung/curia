export type MessageKind = 'user' | 'agent' | 'status' | 'error';

export interface Message {
  id: string;        // crypto.randomUUID() — stable React key
  kind: MessageKind;
  text: string;
  html?: string;     // Pre-rendered HTML for agent messages (server-side markdown conversion)
  timestamp?: Date;  // Display time; absent for status and error messages
}

/**
 * A parsed SSE event from GET /api/kg/chat/stream, normalized for the chat UI.
 * - status:   intermediate progress (skill invocation) — append as a status line.
 * - reply:    the agent's final reply for this turn (terminal).
 * - rejected: the turn was rejected before reaching the agent (terminal error).
 * parseSseEvent returns null for everything else (skill.result, malformed, etc.).
 */
export type SseEvent =
  | { kind: 'status'; text: string }
  | { kind: 'reply'; text: string; html: string | null }
  | { kind: 'rejected'; text: string };

/** A chat history row as returned by GET /api/kg/chat/history. */
export interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  html: string | null;
  timestamp: string;
}
