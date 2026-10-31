// apps/console/src/pages/chat/useChatSession.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import { apiFetch } from '../../api.js';
import { makeMessage, mergeLiveTail, nextReconnectDelayMs, parseSseEvent, pickRecoveredReply } from './chat-utils.js';
import type { Message, HistoryMessage, SseEvent } from './types.js';

// Onboarding kickoff — set by the setup wizard page after form submission.
const ONBOARDING_KICKOFF_KEY = 'curia:onboarding:welcome-banner-pending';
const KICKOFF_TEXT = 'Just finished setup — say hi!';

const HISTORY_PAGE_SIZE = 25;

// Ack-and-stream (#985): the reply arrives over SSE, not the POST. If no terminal
// event arrives within this window (rare: a suppressed-duplicate turn or an agent
// crash), the client fetches /history once to recover a missed reply, then shows a
// soft notice and unlocks the composer WITHOUT closing the stream — a late reply
// still renders. Deliberately long so legitimately slow tasks are never cut off.
const REPLY_WATCHDOG_MS = 5 * 60_000;
// How long to wait for the SSE connection to open before POSTing anyway. If the
// stream is degraded the POST still publishes and the watchdog recovers the reply.
const SSE_OPEN_TIMEOUT_MS = 3_000;
const STILL_WORKING_TEXT =
  'This is taking longer than usual. The reply will appear here if it arrives — you can also resend.';
const RECOVERY_FAILED_TEXT =
  'Could not confirm your message status — the connection may have dropped. You can resend.';

interface ChatSession {
  messages: Message[];
  sending: boolean;
  hasMore: boolean;
  loadingHistory: boolean;
  send: (text: string) => Promise<void>;
  loadMore: () => Promise<void>;
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

  const isSending = useRef(false);
  const isLoadingMore = useRef(false);
  const sourceRef = useRef<EventSource | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempt = useRef(0);
  // True while we closed the socket ourselves (tab hidden, unmount). The error
  // that follows must not schedule another reconnect.
  const closedByUs = useRef(false);
  const mountedRef = useRef(true);
  // Server-owned thread. localStorage is not the source of truth: an installed
  // iOS app does not share it with the Safari tab that paired (#2341).
  const conversationId = useRef<string | null>(null);
  const conversationPromise = useRef<Promise<string> | null>(null);
  const oldestTimestamp = useRef<string | null>(null);
  const onDeadRef = useRef<(() => void) | null>(null);

  const pendingKickoff = useRef(
    (() => {
      if (typeof window === 'undefined') return false;
      let flag: string | null;
      try {
        flag = localStorage.getItem(ONBOARDING_KICKOFF_KEY);
      } catch { return false; }
      if (flag === null) return false;
      try {
        localStorage.removeItem(ONBOARDING_KICKOFF_KEY);
      } catch (err) {
        console.error('[useChatSession] failed to clear onboarding kickoff flag:', err);
      }
      return true;
    })(),
  );

  const appendEvent = useCallback((parsed: SseEvent) => {
    if (parsed.kind === 'user') {
      setMessages((prev) => {
        if (parsed.clientMessageId && prev.some((m) => m.id === parsed.clientMessageId)) return prev;
        return [...prev, makeMessage('user', parsed.text, {
          id: parsed.clientMessageId ?? undefined,
          timestamp: new Date(),
        })];
      });
      return;
    }
    if (parsed.kind === 'reply') {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.kind === 'agent' && last.text === parsed.text) return prev;
        return [...prev, makeMessage('agent', parsed.text, {
          html: parsed.html ?? undefined,
          timestamp: new Date(),
        })];
      });
      return;
    }
    if (parsed.kind === 'status') {
      setMessages((prev) => [...prev, makeMessage('status', parsed.text)]);
      return;
    }
    setMessages((prev) => [...prev, makeMessage('error', parsed.text)]);
  }, []);

  const onEventRef = useRef<(event: SseEvent) => void>(appendEvent);
  useEffect(() => {
    onEventRef.current = appendEvent;
  }, [appendEvent]);

  const closeStream = useCallback(() => {
    closedByUs.current = true;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const openStream = useCallback((convId: string) => {
    if (!mountedRef.current) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const existing = sourceRef.current;
    if (existing && existing.readyState !== EventSource.CLOSED) return;
    closedByUs.current = false;
    const source = new EventSource(
      `/api/chat/stream?conversationId=${encodeURIComponent(convId)}`,
      { withCredentials: true },
    );
    sourceRef.current = source;
    source.onopen = () => { reconnectAttempt.current = 0; };
    source.onmessage = (event: MessageEvent<string>) => {
      const parsed = parseSseEvent(event.data);
      if (parsed) onEventRef.current(parsed);
    };
    source.onerror = () => {
      if (closedByUs.current) return;
      console.error('[useChatSession] SSE stream error (readyState=%d)', source.readyState);
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
      onDeadRef.current?.();
      if (reconnectTimer.current || !mountedRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const delay = nextReconnectDelayMs(reconnectAttempt.current);
      reconnectAttempt.current += 1;
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        openStream(convId);
      }, delay);
    };
  }, []);

  const ensureConversationId = useCallback(async (): Promise<string> => {
    if (conversationId.current) return conversationId.current;
    if (!conversationPromise.current) {
      conversationPromise.current = (async () => {
        const res = await apiFetch('/api/chat/conversation');
        if (!res.ok) throw new Error(`conversation fetch returned ${res.status}`);
        const data = await res.json() as { conversationId?: unknown };
        if (typeof data.conversationId !== 'string' || data.conversationId.length === 0) {
          throw new Error('conversation fetch returned no id');
        }
        conversationId.current = data.conversationId;
        return data.conversationId;
      })().catch((err: unknown) => {
        conversationPromise.current = null;
        throw err;
      });
    }
    return conversationPromise.current;
  }, []);

  const loadInitialHistory = useCallback(async (convId: string) => {
    setLoadingHistory(true);
    try {
      const res = await apiFetch(
        `/api/chat/history?conversationId=${encodeURIComponent(convId)}&limit=${HISTORY_PAGE_SIZE}`,
      );
      if (!res.ok) {
        console.error('[useChatSession] initial history fetch returned non-ok status:', res.status);
        return;
      }
      const data = (await res.json()) as HistoryResponse;
      if (data.messages.length === 0) return;
      const loaded = historyToMessages(data.messages);
      setMessages((prev) => mergeLiveTail(loaded, prev));
      setHasMore(data.hasMore);
      const first = data.messages[0];
      if (first) oldestTimestamp.current = first.timestamp;
    } catch (err: unknown) {
      console.error('[useChatSession] initial history fetch failed:', err);
    } finally {
      setLoadingHistory(false);
    }
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
        `/api/chat/history?conversationId=${encodeURIComponent(convId)}&limit=${HISTORY_PAGE_SIZE}${cursor}`,
      );
      if (!res.ok) {
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
      console.error('[useChatSession] loadMore failed:', err);
      setHasMore(false);
    } finally {
      isLoadingMore.current = false;
      setLoadingHistory(false);
    }
  }, [hasMore]);

  async function send(text: string): Promise<void> {
    if (isSending.current || text.trim().length === 0) return;

    let convId: string;
    try {
      convId = await ensureConversationId();
    } catch (err) {
      console.error('[useChatSession] failed to resolve the shared thread:', err);
      setMessages((prev) => [...prev, makeMessage('error', 'Could not open the conversation. Try again.')]);
      return;
    }

    const clientMessageId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      makeMessage('user', text, { id: clientMessageId, timestamp: new Date() }),
    ]);
    isSending.current = true;
    setSending(true);

    let settled = false;
    let recoveryStarted = false;

    const unlock = () => {
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      isSending.current = false;
      setSending(false);
    };
    // The turn is done. The stream stays open for the next message and for
    // anything another device sends.
    const settle = () => {
      if (settled) return;
      settled = true;
      onDeadRef.current = null;
      onEventRef.current = appendEvent;
      unlock();
    };

    const runRecovery = async () => {
      if (recoveryStarted || settled) return;
      recoveryStarted = true;

      let fetchOk = false;
      try {
        const res = await apiFetch(
          `/api/chat/history?conversationId=${encodeURIComponent(convId)}&limit=${HISTORY_PAGE_SIZE}`,
        );
        if (settled) return;
        if (res.ok) {
          fetchOk = true;
          const data = (await res.json()) as HistoryResponse;
          if (settled) return;
          const recovered = pickRecoveredReply(data.messages);
          if (recovered) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.kind === 'agent' && last.text === recovered.text) return prev;
              return [...prev, makeMessage('agent', recovered.text, {
                html: recovered.html ?? undefined,
                timestamp: new Date(),
              })];
            });
            settle();
            return;
          }
        } else {
          console.error('[useChatSession] recovery history fetch non-ok:', res.status);
        }
      } catch (err) {
        console.error('[useChatSession] recovery history fetch failed:', err);
      }

      if (settled) return;
      if (!fetchOk) {
        setMessages((prev) => [...prev, makeMessage('error', RECOVERY_FAILED_TEXT)]);
        settle();
        return;
      }
      setMessages((prev) => [...prev, makeMessage('status', STILL_WORKING_TEXT)]);
      unlock();
    };

    onEventRef.current = (parsed) => {
      appendEvent(parsed);
      if (parsed.kind === 'reply' || parsed.kind === 'rejected') settle();
    };
    onDeadRef.current = () => { void runRecovery(); };

    try {
      openStream(convId);
      const source = sourceRef.current;
      if (source && source.readyState !== EventSource.OPEN) {
        await new Promise<void>((resolve) => {
          const to = setTimeout(resolve, SSE_OPEN_TIMEOUT_MS);
          const previous = source.onopen;
          source.onopen = (event) => {
            clearTimeout(to);
            reconnectAttempt.current = 0;
            if (typeof previous === 'function') previous.call(source, event);
            resolve();
          };
        });
      }

      const res = await apiFetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, clientMessageId }),
      });

      if (!res.ok) {
        let errMsg = `Error ${res.status}`;
        try {
          const errData = await res.json() as { error?: string };
          if (errData.error) errMsg = errData.error;
        } catch (bodyErr) {
          console.error('[useChatSession] failed to parse error response body:', bodyErr);
        }
        setMessages((prev) => [...prev, makeMessage('error', errMsg)]);
        settle();
        return;
      }

      if (!settled) {
        watchdogRef.current = setTimeout(() => { void runRecovery(); }, REPLY_WATCHDOG_MS);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setMessages((prev) => [...prev, makeMessage('error', msg)]);
      settle();
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    // Captured before a strict-mode remount re-inits the ref from an already
    // cleared flag. The in-flight call still sends once.
    const kickoff = pendingKickoff.current;
    pendingKickoff.current = false;

    void (async () => {
      try {
        const id = await ensureConversationId();
        if (!cancelled) await loadInitialHistory(id);
        if (!cancelled && document.visibilityState === 'visible') openStream(id);
        if (kickoff) void send(KICKOFF_TEXT);
      } catch (err) {
        console.error('[useChatSession] failed to open the shared thread:', err);
      }
    })();

    const onVisibility = () => {
      const id = conversationId.current;
      if (document.visibilityState === 'hidden') {
        closeStream();
        onDeadRef.current?.();
        return;
      }
      if (id) openStream(id);
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      closeStream();
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    };
  // send reads refs and functional setState. Listing it would re-subscribe the
  // stream on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { messages, sending, hasMore, loadingHistory, send, loadMore };
}
