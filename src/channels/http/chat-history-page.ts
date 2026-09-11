import { isVoiceGreetingCueContent } from '../voice/greeting.js';
import { stripOutboundContextPreamble } from '../../dispatch/outbound-context.js';
import { rewriteLlmFailureTurns } from '../../memory/llm-failure-turn.js';

export interface ChatHistoryRow {
  id: string;
  role: string;
  content: string;
  created_at: Date;
}

export interface ChatHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  html: string | null;
  timestamp: string;
}

export interface FetchChatHistoryPageOptions {
  before?: Date;
  limit: number;
  load: (before: Date | undefined, fetchLimit: number) => Promise<ChatHistoryRow[]>;
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
    timestamp: row.created_at.toISOString(),
  };
}

/**
 * Fill a page of `limit` *display* messages, not raw working_memory rows.
 *
 * `hasMore` is true iff at least `limit + 1` displayable turns exist older
 * than `before`. An all-filtered raw batch continues scanning so the console
 * cannot dead-end on an empty page (`useChatSession` treats `messages: []`
 * as terminal regardless of `hasMore`) (#1775).
 */
export async function fetchChatHistoryPage(
  options: FetchChatHistoryPageOptions,
): Promise<{ messages: ChatHistoryMessage[]; hasMore: boolean }> {
  const { limit, load, renderAssistantHtml, onMarkdownError } = options;
  const newestFirst: ChatHistoryMessage[] = [];
  let cursor = options.before;

  while (newestFirst.length <= limit) {
    const remaining = limit + 1 - newestFirst.length;
    // Over-fetch because some rows are dropped. 2× covers the paired voice-cue
    // case; the loop continues when a batch is still short of `limit + 1`.
    const batchSize = remaining * 2;
    const rows = await load(cursor, batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = row.created_at;
      const message = toChatHistoryMessage(row, renderAssistantHtml, onMarkdownError);
      if (!message) continue;
      newestFirst.push(message);
      if (newestFirst.length > limit) break;
    }

    if (newestFirst.length > limit) break;
    if (rows.length < batchSize) break;
  }

  return {
    messages: newestFirst.slice(0, limit).reverse(),
    hasMore: newestFirst.length > limit,
  };
}
