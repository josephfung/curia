// apps/console/src/pages/chat/useChatSession.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import { apiFetch } from '../../api.js';
import { makeMessage, parseSseEvent } from './chat-utils.js';
import type { Message } from './types.js';

// localStorage key for persisting the conversationId across page reloads.
const CONV_ID_KEY = 'curia:chat:conversationId';
// Onboarding kickoff — set by the setup wizard page after form submission.
const ONBOARDING_KICKOFF_KEY = 'curia:onboarding:welcome-banner-pending';
const KICKOFF_TEXT = 'Just finished setup — say hi!';

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

  // isSending and isLoadingMore are refs so their guards are immune to stale closures.
  // Using refs rather than state prevents the IntersectionObserver from tearing
  // down and re-mounting on every loadMore cycle (which could cause a double-fetch
  // during the brief window when state hasn't propagated to the observer's closure).
  const isSending = useRef(false);
  const isLoadingMore = useRef(false);
  // Holds the active EventSource so cleanup can close it on unmount.
  const sourceRef = useRef<EventSource | null>(null);
  // One conversationId per chat thread — persisted in localStorage.
  // localStorage.getItem can throw SecurityError in restricted browsing contexts
  // (e.g. Safari private mode with strict settings), so we guard the read.
  const conversationId = useRef<string | null>(
    (() => {
      if (typeof window === 'undefined') return null;
      try { return localStorage.getItem(CONV_ID_KEY); } catch { return null; }
    })(),
  );
  // One-shot kickoff: read and clear the onboarding flag synchronously so a
  // React strict-mode double-mount cannot fire a second auto-send.
  const pendingKickoff = useRef(
    (() => {
      if (typeof window === 'undefined') return false;
      let flag: string | null;
      try {
        // Guard getItem separately — throws SecurityError in restricted contexts (e.g. Safari private mode).
        flag = localStorage.getItem(ONBOARDING_KICKOFF_KEY);
      } catch { return false; }
      if (flag === null) return false;
      // Clear unconditionally so the flag is truly one-shot, even when we skip
      // the kickoff below because a conversation already exists.
      try {
        localStorage.removeItem(ONBOARDING_KICKOFF_KEY);
      } catch (err) {
        // removeItem failed after reading the flag. Log it but still fire the kickoff —
        // the worst case is a double-send on the next mount (harmless; conversationId
        // will exist by then and the guard below will prevent it).
        console.error('[useChatSession] failed to clear onboarding kickoff flag:', err);
      }
      if (conversationId.current) return false;
      return true;
    })(),
  );
  // ISO timestamp of the oldest loaded message — used as the pagination cursor.
  const oldestTimestamp = useRef<string | null>(null);

  // Close any in-flight SSE connection when the component unmounts.
  useEffect(() => () => { sourceRef.current?.close(); }, []);

  // On mount, if we have a stored conversationId, load the most recent history page.
  useEffect(() => {
    const convId = conversationId.current;
    if (!convId) return;

    // Using an inner async function inside useEffect so we can await cleanly
    // while still returning a synchronous cleanup function from the effect.
    const load = async () => {
      setLoadingHistory(true);
      try {
        const res = await apiFetch(
          `/api/kg/chat/history?conversationId=${encodeURIComponent(convId)}&limit=${HISTORY_PAGE_SIZE}`,
        );
        if (!res.ok) {
          console.error('[useChatSession] initial history fetch returned non-ok status:', res.status);
          return;
        }
        const data = (await res.json()) as HistoryResponse;
        if (data.messages.length === 0) return;
        const loaded = historyToMessages(data.messages);
        // Functional update guards against a race where the user sends a message
        // before history arrives: only replace state if no messages have been added yet.
        setMessages((prev) => (prev.length === 0 ? loaded : [...loaded, ...prev]));
        setHasMore(data.hasMore);
        // Record the timestamp of the oldest loaded message for subsequent loadMore calls.
        const first = data.messages[0];
        if (first) oldestTimestamp.current = first.timestamp;
      } catch (err: unknown) {
        // History fetch is best-effort — a failure doesn't prevent new messages.
        console.error('[useChatSession] initial history fetch failed:', err);
      } finally {
        setLoadingHistory(false);
      }
    };

    void load();
  // Run once on mount; conversationId.current is a ref, not a reactive dep.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-send the onboarding kickoff message once on first mount.
  // send is captured from this render; deps omitted intentionally (one-shot).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pendingKickoff.current) return;
    void send(KICKOFF_TEXT);
  }, []);

  const loadMore = useCallback(async () => {
    const convId = conversationId.current;
    if (!convId || isLoadingMore.current || !hasMore) return;

    isLoadingMore.current = true;
    setLoadingHistory(true);
    try {
      const cursor = oldestTimestamp.current
        ? `&before=${encodeURIComponent(oldestTimestamp.current)}`
        : '';
      const res = await apiFetch(
        `/api/kg/chat/history?conversationId=${encodeURIComponent(convId)}&limit=${HISTORY_PAGE_SIZE}${cursor}`,
      );
      if (!res.ok) {
        // Treat non-ok as terminal to prevent the IntersectionObserver from
        // re-triggering loadMore in an infinite retry loop while hasMore is still true.
        console.error('[useChatSession] loadMore returned non-ok status:', res.status);
        setHasMore(false);
        return;
      }
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
    } catch (err) {
      // Treat network errors as terminal (same infinite-retry guard as non-ok above).
      console.error('[useChatSession] loadMore failed:', err);
      setHasMore(false);
    } finally {
      isLoadingMore.current = false;
      setLoadingHistory(false);
    }
  }, [hasMore]);

  async function send(text: string): Promise<void> {
    if (isSending.current || text.trim().length === 0) return;

    if (!conversationId.current) {
      const newId = crypto.randomUUID();
      conversationId.current = newId;
      // Guarded for restricted browsing contexts (e.g. Safari private mode).
      try { localStorage.setItem(CONV_ID_KEY, newId); } catch { /* best-effort */ }
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
      // Runtime guard above confirmed `reply` is a string; cast through unknown
      // per project convention for narrowing from Record<string, unknown>.
      const data = raw as unknown as { reply: string; html: string | null; conversationId: string };
      setMessages((prev) => [
        ...prev,
        makeMessage('agent', data.reply, {
          html: data.html ?? undefined,
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
