import { isVoiceGreetingCueContent } from '../voice/greeting.js';
import { stripOutboundContextPreamble } from '../../dispatch/outbound-context.js';
import { rewriteLlmFailureTurns } from '../../memory/llm-failure-turn.js';

/** Hard cap on raw rows scanned in one HTTP request. */
export const CHAT_HISTORY_MAX_ROWS_SCANNED = 500;
/** Absolute cap even when the page is still empty (console dead-end vs unbounded scan). */
export const CHAT_HISTORY_ABSOLUTE_MAX_ROWS_SCANNED = 2000;

export interface ChatHistoryRow {
  id: string;
  role: string;
  content: string;
  created_at: Date;
  /**
   * UTC timestamptz with microseconds (`YYYY-MM-DDTHH:MM:SS.USZ`). JS `Date`
   * truncates to milliseconds; keyset pagination must not.
   */
  created_at_iso: string;
}

export interface ChatHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  html: string | null;
  timestamp: string;
}

export interface ChatHistoryCursor {
  createdAtIso: string;
  id?: string;
}

export interface FetchChatHistoryPageOptions {
  before?: ChatHistoryCursor;
  limit: number;
  load: (cursor: ChatHistoryCursor | undefined, fetchLimit: number) => Promise<ChatHistoryRow[]>;
  renderAssistantHtml: (content: string) => string;
  onMarkdownError?: (err: unknown, messageId: string) => void;
}

/**
 * Display-layer filters for `GET /api/kg/chat/history`.
 *
 * Adding a new rule that drops or rewrites a chat bubble belongs here.
 * `WorkingMemory.getHistory` applies `rewriteLlmFailureTurns` separately as
 * the LLM-safe default; this layer additionally drops the voice greeting cue
 * (#1596) and strips outbound-context preambles, which must not apply to LLM
 * context.
 */
export function toChatHistoryMessage(
  row: ChatHistoryRow,
  renderAssistantHtml: (content: string) => string,
  onMarkdownError?: (err: unknown, messageId: string) => void,
): ChatHistoryMessage | null {
  if (row.role !== 'user' && row.role !== 'assistant') return null;
  if (row.role === 'user' && isVoiceGreetingCueContent(row.content)) return null;

  const rewritten = rewriteLlmFailureTurns([row])[0]!;
  const content = rewritten.role === 'user'
    ? stripOutboundContextPreamble(rewritten.content)
    : rewritten.content;

  let html: string | null = null;
  if (rewritten.role === 'assistant') {
    try {
      html = renderAssistantHtml(content);
    } catch (err) {
      onMarkdownError?.(err, row.id);
    }
  }

  return {
    id: row.id,
    role: rewritten.role as 'user' | 'assistant',
    content,
    html,
    // Microsecond ISO so the client's next `before` cursor round-trips through
    // Postgres without the JS Date millisecond truncation (#1775 review).
    timestamp: row.created_at_iso,
  };
}

/**
 * Fill a page of `limit` *display* messages, not raw working_memory rows.
 *
 * `hasMore` is true iff at least `limit + 1` displayable turns exist older
 * than `before`. An all-filtered raw batch continues scanning so the console
 * cannot dead-end on an empty page (`useChatSession` treats `messages: []`
 * as terminal regardless of `hasMore`) (#1775).
 *
 * Each fetch is at least `limit + 1` rows so the common unfiltered case is a
 * single query (same I/O as before this PR) and a late run of filtered rows
 * cannot degrade into one round trip per two rows. A scan cap bounds the
 * pathological all-filtered case.
 */
export async function fetchChatHistoryPage(
  options: FetchChatHistoryPageOptions,
): Promise<{ messages: ChatHistoryMessage[]; hasMore: boolean }> {
  const { limit, load, renderAssistantHtml, onMarkdownError } = options;
  const newestFirst: ChatHistoryMessage[] = [];
  let cursor = options.before;
  let scanned = 0;
  let lastBatchFull = false;

  while (newestFirst.length <= limit) {
    if (scanned >= CHAT_HISTORY_MAX_ROWS_SCANNED && newestFirst.length > 0) break;
    if (scanned >= CHAT_HISTORY_ABSOLUTE_MAX_ROWS_SCANNED) break;

    // Always `limit + 1`: the unfiltered common case is one query (same I/O as
    // the previous LIMIT 26), and a late run of filtered rows cannot shrink
    // into one round trip per two rows.
    const batchSize = limit + 1;
    const rows = await load(cursor, batchSize);
    if (rows.length === 0) {
      lastBatchFull = false;
      break;
    }
    scanned += rows.length;
    lastBatchFull = rows.length >= batchSize;

    for (const row of rows) {
      cursor = { createdAtIso: row.created_at_iso, id: row.id };
      const message = toChatHistoryMessage(row, renderAssistantHtml, onMarkdownError);
      if (!message) continue;
      newestFirst.push(message);
      if (newestFirst.length > limit) break;
    }

    if (newestFirst.length > limit) break;
    if (!lastBatchFull) break;
  }

  const hitScanCap = scanned >= CHAT_HISTORY_MAX_ROWS_SCANNED
    || scanned >= CHAT_HISTORY_ABSOLUTE_MAX_ROWS_SCANNED;

  return {
    messages: newestFirst.slice(0, limit).reverse(),
    hasMore: newestFirst.length > limit || (hitScanCap && lastBatchFull && newestFirst.length > 0),
  };
}
