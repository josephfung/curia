// apps/console/src/pages/chat/useChatSession.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import { apiFetch } from '../../api.js';
import { makeMessage, parseSseEvent } from './chat-utils.js';
import type { Message } from './types.js';

// localStorage key for persisting the conversationId across page reloads.
const CONV_ID_KEY = 'curia:chat:conversationId';

const HISTORY_PAGE_SIZE = 25;

interface ChatSession {
  messages: Message[];
  sending: boolean;
  hasMore: boolean;
  loadingHistory: boolean;
  send: (text: string) => Promise<void>;
  loadMore: () => Promise<void>;
}

interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  html: string | null;
  timestamp: string;
}

interface HistoryResponse {
  messages: HistoryMessage[];
  hasMore: boolean;
}

function historyToMessages(items: HistoryMessage[]): Message[] {
  return items.map((item) => ({
    id: item.id,
    kind: (item.role === 'assistant' ? 'agent' : 'user') as Message['kind'],
    text: item.content,
    html: item.html ?? undefined,
    timestamp: new Date(item.timestamp),
  }));
}

export function useChatSession(): ChatSession {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // isSending is a ref so the double-send guard is immune to stale closures.
  const isSending = useRef(false);
  // Holds the active EventSource so cleanup can close it on unmount.
  const sourceRef = useRef<EventSource | null>(null);
  // One conversationId per chat thread — persisted in localStorage.
  const conversationId = useRef<string | null>(
    typeof window !== 'undefined' ? localStorage.getItem(CONV_ID_KEY) : null,
  );
  // ISO timestamp of the oldest loaded message — used as the pagination cursor.
  const oldestTimestamp = useRef<string | null>(null);

  // Close any in-flight SSE connection when the component unmounts.
  useEffect(() => () => { sourceRef.current?.close(); }, []);

  // On mount, if we have a stored conversationId, load the most recent history page.
  useEffect(() => {
    const convId = conversationId.current;
    if (!convId) return;

    setLoadingHistory(true);
    apiFetch(
      `/api/kg/chat/history?conversationId=${encodeURIComponent(convId)}&limit=${HISTORY_PAGE_SIZE}`,
    )
      .then((res) => {
        if (!res.ok) return;
        return res.json() as Promise<HistoryResponse>;
      })
      .then((data) => {
        if (!data || data.messages.length === 0) return;
        const loaded = historyToMessages(data.messages);
        setMessages(loaded);
        setHasMore(data.hasMore);
        // Record the timestamp of the oldest loaded message for subsequent loadMore calls.
        const first = data.messages[0];
        if (first) oldestTimestamp.current = first.timestamp;
      })
      .catch(() => {
        // History fetch is best-effort — a failure doesn't prevent new messages.
      })
      .finally(() => setLoadingHistory(false));
  // Run once on mount; conversationId.current is a ref, not a reactive dep.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMore = useCallback(async () => {
    const convId = conversationId.current;
    if (!convId || loadingHistory || !hasMore) return;

    setLoadingHistory(true);
    try {
      const cursor = oldestTimestamp.current
        ? `&before=${encodeURIComponent(oldestTimestamp.current)}`
        : '';
      const res = await apiFetch(
        `/api/kg/chat/history?conversationId=${encodeURIComponent(convId)}&limit=${HISTORY_PAGE_SIZE}${cursor}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as HistoryResponse;
      if (data.messages.length === 0) {
        setHasMore(false);
        return;
      }
      const older = historyToMessages(data.messages);
      setMessages((prev) => [...older, ...prev]);
      setHasMore(data.hasMore);
      const first = data.messages[0];
      if (first) oldestTimestamp.current = first.timestamp;
    } catch {
      // loadMore failures are non-fatal — the visible thread is unaffected.
    } finally {
      setLoadingHistory(false);
    }
  }, [loadingHistory, hasMore]);

  async function send(text: string): Promise<void> {
    if (isSending.current || text.trim().length === 0) return;

    if (!conversationId.current) {
      const newId = crypto.randomUUID();
      conversationId.current = newId;
      localStorage.setItem(CONV_ID_KEY, newId);
    }
    const convId = conversationId.current;

    // Optimistic append so the user sees their message immediately.
    setMessages((prev) => [
      ...prev,
      makeMessage('user', text, { timestamp: new Date() }),
    ]);
    isSending.current = true;
    setSending(true);

    // EventSource is created inside try so a synchronous constructor failure
    // (e.g. CSP block) hits the catch block and resets the sending state.
    let source: EventSource | undefined;
    try {
      // Open the SSE stream BEFORE the POST to avoid racing a fast reply.
      // withCredentials sends the session cookie, matching apiFetch behavior.
      source = new EventSource(
        `/api/kg/chat/stream?conversationId=${encodeURIComponent(convId)}`,
        { withCredentials: true },
      );
      sourceRef.current = source as EventSource;
      source.onmessage = (event: MessageEvent<string>) => {
        const statusText = parseSseEvent(event.data);
        if (statusText) {
          setMessages((prev) => [...prev, makeMessage('status', statusText)]);
        }
      };
      source.onerror = (event) => {
        // SSE failures are non-fatal — the POST response is authoritative.
        // Close immediately to prevent the browser's automatic reconnection loop.
        console.error('[useChatSession] SSE stream error:', event);
        // source is always defined here — onerror can only fire after construction.
        source!.close();
      };

      const res = await apiFetch('/api/kg/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId: convId }),
      });

      if (!res.ok) {
        let errMsg = `Error ${res.status}`;
        try {
          const errData = await res.json() as { error?: string };
          if (errData.error) errMsg = errData.error;
        } catch (bodyErr) {
          // Non-JSON error body — log for debugging, fall back to HTTP status.
          console.error('[useChatSession] failed to parse error response body:', bodyErr);
        }
        setMessages((prev) => [...prev, makeMessage('error', errMsg)]);
        return;
      }

      const raw = await res.json() as unknown;
      if (
        typeof raw !== 'object' ||
        raw === null ||
        typeof (raw as Record<string, unknown>)['reply'] !== 'string'
      ) {
        console.error('[useChatSession] unexpected response shape:', raw);
        setMessages((prev) => [...prev, makeMessage('error', 'Received an unexpected response.')]);
        return;
      }
      const data = raw as { reply: string; html: string; conversationId: string };
      setMessages((prev) => [
        ...prev,
        makeMessage('agent', data.reply, {
          html: data.html,
          timestamp: new Date(),
        }),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setMessages((prev) => [...prev, makeMessage('error', msg)]);
    } finally {
      isSending.current = false;
      source?.close();
      sourceRef.current = null;
      setSending(false);
    }
  }

  return { messages, sending, hasMore, loadingHistory, send, loadMore };
}
