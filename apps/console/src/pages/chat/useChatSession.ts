// apps/console/src/pages/chat/useChatSession.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { apiFetch } from '../../api.js';
import { makeMessage, mergeLiveTail, nextReconnectDelayMs, parseSseEvent, pickRecoveredReply } from './chat-utils.js';
import type { Message, HistoryMessage, SseEvent } from './types.js';

// Onboarding kickoff — set by the setup wizard page after form submission.
const ONBOARDING_KICKOFF_KEY = 'curia:onboarding:welcome-banner-pending';
const LEGACY_CONVERSATION_KEY = 'curia:chat:conversationId';
const KICKOFF_TEXT = 'Just finished setup — say hi!';
const CANT_REACH_TEXT = "Can't reach Curia, retrying";
/** Reconnect when no SSE bytes, including the data ping, have arrived. */
const STREAM_SILENCE_MS = 60_000;

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
// Shown only by the five-minute watchdog, after a history fetch that succeeded
// and still had no reply. Phrased "if it arrives" because a slow turn and a
// turn that will never reply look the same from here. A hide or a dropped
// socket must not use this copy: the reconnect catch-up settles that turn.
const STILL_WORKING_TEXT =
  'This is taking longer than usual. The reply will appear here if it arrives — you can also resend.';
// Shown when the watchdog's history fetch itself failed. The status is unknown,
// so the copy does not promise that a reply is on the way.
const RECOVERY_FAILED_TEXT =
  'Could not confirm your message status — the connection may have dropped. You can resend.';

interface ChatSession {
  messages: Message[];
  sending: boolean;
  hasMore: boolean;
  loadingHistory: boolean;
  connectionError: string | null;
  send: (text: string) => Promise<void>;
  loadMore: () => Promise<void>;
}

interface HistoryResponse {
  messages: HistoryMessage[];
  hasMore: boolean;
}

class SessionEnded extends Error {}

/**
 * The reply to the in-flight send, or null when the page's last user row is
 * still the previous turn. Matching on text alone would settle "q2" with the
 * reply to "q1" when the new row has not been saved yet.
 */
function replyForInflight(
  items: HistoryMessage[],
  inflight: string | null,
  knownIds: Set<string>,
): { text: string; html: string | null } | null {
  if (!inflight) return null;
  let lastUser: HistoryMessage | undefined;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]!.role === 'user') {
      lastUser = items[i];
      break;
    }
  }
  if (!lastUser || lastUser.content !== inflight || knownIds.has(lastUser.id)) return null;
  return pickRecoveredReply(items);
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
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // isSending and isLoadingMore are refs so their guards are immune to stale
  // closures. State would re-render the composer and re-mount the thread on
  // every loadMore cycle, which could cause a double-fetch.
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
  const lastActivity = useRef(0);
  const settleTurnRef = useRef<(() => void) | null>(null);
  // Latest rendered thread, so send() can tell a catch-up page's last user row
  // from the message it just added.
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  // The user text of the turn in flight, and the ids already on screen when it
  // started. Catch-up settles only when history's last user row is that text
  // and was not already on screen.
  const inflightText = useRef<string | null>(null);
  const inflightKnownIds = useRef<Set<string>>(new Set());
  // History ids folded onto a live copy. The live row keeps its client id, so
  // the server id would otherwise look like a new turn.
  const seenHistoryIds = useRef<Set<string>>(new Set());
  // Initial history has its own retry. closeStream() clears the SSE timer, and
  // hiding the tab must not cancel the thread open.
  const threadRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadReady = useRef(false);
  // One identical SSE reply is dropped after catch-up already rendered it.
  // A later repeat is a real message and is kept.
  const suppressNextReply = useRef<string | null>(null);

  const pendingKickoff = useRef(
    (() => {
      if (typeof window === 'undefined') return false;
      try {
        // getItem throws SecurityError in Safari private mode. The key stays
        // until the kickoff is actually sent, so a cancelled open can retry.
        return localStorage.getItem(ONBOARDING_KICKOFF_KEY) !== null;
      } catch {
        return false;
      }
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
      // Outside the updater: React may run an updater twice, and the first
      // run would consume the suppression before the second appends.
      if (suppressNextReply.current === parsed.text) {
        suppressNextReply.current = null;
        return;
      }
      setMessages((prev) => [...prev, makeMessage('agent', parsed.text, {
        html: parsed.html ?? undefined,
        timestamp: new Date(),
      })]);
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

  const catchUp = useCallback(async (convId: string) => {
    try {
      const res = await apiFetch(
        `/api/chat/history?conversationId=${encodeURIComponent(convId)}&limit=${HISTORY_PAGE_SIZE}`,
      );
      if (res.status === 401) {
        await navigate({ to: '/login' });
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as HistoryResponse;
      const loaded = historyToMessages(data.messages);
      const pairedOnto = new Map<string, string>();
      const merged = mergeLiveTail(loaded, messagesRef.current, pairedOnto);
      messagesRef.current = merged;
      setMessages(() => merged);
      const known = new Set(inflightKnownIds.current);
      for (const [historyId, liveId] of pairedOnto) {
        if (!known.has(liveId)) continue;
        known.add(historyId);
        seenHistoryIds.current.add(historyId);
      }
      const recovered = replyForInflight(data.messages, inflightText.current, known);
      if (recovered && isSending.current) {
        suppressNextReply.current = recovered.text;
        settleTurnRef.current?.();
      }
    } catch (err) {
      console.error('[useChatSession] catch-up history failed:', err);
    }
  }, [navigate]);

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
    const touch = () => { lastActivity.current = Date.now(); };
    source.onopen = () => {
      touch();
      reconnectAttempt.current = 0;
      // Including the first open: a message can land between the history
      // response and this socket.
      void catchUp(convId);
    };
    source.onmessage = (event: MessageEvent<string>) => {
      touch();
      const parsed = parseSseEvent(event.data);
      if (parsed) onEventRef.current(parsed);
    };
    source.onerror = () => {
      if (closedByUs.current) return;
      console.error('[useChatSession] SSE stream error (readyState=%d)', source.readyState);
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
      if (reconnectTimer.current || !mountedRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const attempt = reconnectAttempt.current;
      reconnectAttempt.current += 1;
      const delay = nextReconnectDelayMs(attempt);
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        void (async () => {
          if (attempt >= 1) {
            try {
              const probe = await apiFetch('/api/chat/conversation');
              if (probe.status === 401) {
                await navigate({ to: '/login' });
                return;
              }
            } catch (err) {
              console.error('[useChatSession] session probe failed:', err);
            }
          }
          if (!mountedRef.current) return;
          openStream(convId);
        })();
      }, delay);
    };
  }, [catchUp, navigate]);

  const ensureConversationId = useCallback(async (): Promise<string> => {
    if (conversationId.current) return conversationId.current;
    if (!conversationPromise.current) {
      conversationPromise.current = (async () => {
        const res = await apiFetch('/api/chat/conversation');
        if (res.status === 401) {
          await navigate({ to: '/login' });
          throw new SessionEnded();
        }
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
  }, [navigate]);

  const loadInitialHistory = useCallback(async (convId: string): Promise<boolean> => {
    setLoadingHistory(true);
    try {
      const res = await apiFetch(
        `/api/chat/history?conversationId=${encodeURIComponent(convId)}&limit=${HISTORY_PAGE_SIZE}`,
      );
      if (res.status === 401) {
        await navigate({ to: '/login' });
        throw new SessionEnded();
      }
      if (!res.ok) {
        throw new Error(`initial history fetch returned ${res.status}`);
      }
      const data = (await res.json()) as HistoryResponse;
      if (data.messages.length === 0) return false;
      const loaded = historyToMessages(data.messages);
      setMessages((prev) => mergeLiveTail(loaded, prev));
      setHasMore(data.hasMore);
      const first = data.messages[0];
      if (first) oldestTimestamp.current = first.timestamp;
      return true;
    } finally {
      setLoadingHistory(false);
    }
  }, [navigate]);

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
        // A failed page must stop the loader. Leaving hasMore true re-triggers
        // loadMore in an infinite retry loop.
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
      // Network errors are terminal too (same infinite-retry guard as non-ok).
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
    // A suppression left over from the previous turn would swallow this one
    // when the reply text happens to match.
    suppressNextReply.current = null;
    inflightText.current = text;
    const known = new Set(messagesRef.current.map((message) => message.id));
    for (const id of seenHistoryIds.current) known.add(id);
    inflightKnownIds.current = known;
    const next = [
      ...messagesRef.current,
      makeMessage('user', text, { id: clientMessageId, timestamp: new Date() }),
    ];
    messagesRef.current = next;
    setMessages(() => next);
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
      inflightText.current = null;
      settleTurnRef.current = null;
      onEventRef.current = appendEvent;
      unlock();
    };
    settleTurnRef.current = settle;

    // One history fetch for a turn the five-minute watchdog still hasn't seen.
    // Three outcomes: a reply (render it and settle), a failed fetch (status
    // unknown), or a successful fetch with no reply yet (soft notice, composer
    // unlocks, the stream stays open).
    const runRecovery = async () => {
      if (recoveryStarted || settled) return;
      recoveryStarted = true;

      let fetchOk = false;
      try {
        const res = await apiFetch(
          `/api/chat/history?conversationId=${encodeURIComponent(convId)}&limit=${HISTORY_PAGE_SIZE}`,
        );
        // A terminal event may have settled the turn during the await.
        if (settled) return;
        if (res.ok) {
          fetchOk = true;
          const data = (await res.json()) as HistoryResponse;
          // Same re-check after the body parse.
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

      // The turn may have settled while the fetch was in flight.
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

    try {
      // Open the stream and wait before the POST so a fast reply can't race past it.
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
          // Non-JSON error body. The status code is the message the user sees.
          console.error('[useChatSession] failed to parse error response body:', bodyErr);
        }
        setMessages((prev) => [...prev, makeMessage('error', errMsg)]);
        settle();
        return;
      }

      // A fast reply can settle between the onopen gate and this line. Arming
      // the watchdog then would fetch /history and append that reply again.
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
    try {
      localStorage.removeItem(LEGACY_CONVERSATION_KEY);
    } catch (err) {
      console.error('[useChatSession] failed to clear the legacy conversation id:', err);
    }
    // True while an open is waiting on history. resume() must not start a
    // second one: both would see an empty thread and post the kickoff.
    let opening = false;

    const openThread = (attempt = 0) => {
      if (threadRetryTimer.current) {
        clearTimeout(threadRetryTimer.current);
        threadRetryTimer.current = null;
      }
      opening = true;
      void (async () => {
        try {
          const id = await ensureConversationId();
          if (cancelled) return;
          const hadHistory = await loadInitialHistory(id);
          if (cancelled) return;
          threadReady.current = true;
          setConnectionError(null);
          if (document.visibilityState === 'visible') openStream(id);
          // Read here, not at effect start. A cancelled run leaves the flag
          // for the next one. A wizard re-run must not post "say hi" into a
          // thread that already has messages.
          if (pendingKickoff.current && !hadHistory) {
            pendingKickoff.current = false;
            try {
              localStorage.removeItem(ONBOARDING_KICKOFF_KEY);
            } catch (err) {
              console.error('[useChatSession] failed to clear onboarding kickoff flag:', err);
            }
            void send(KICKOFF_TEXT);
          }
        } catch (err) {
          if (err instanceof SessionEnded) return;
          console.error('[useChatSession] failed to open the shared thread:', err);
          if (cancelled) return;
          setConnectionError(CANT_REACH_TEXT);
          const delay = nextReconnectDelayMs(attempt);
          threadRetryTimer.current = setTimeout(() => {
            threadRetryTimer.current = null;
            if (!cancelled) openThread(attempt + 1);
          }, delay);
        } finally {
          opening = false;
        }
      })();
    };
    openThread();

    const resume = () => {
      if (!threadReady.current || !conversationId.current) {
        if (!opening) openThread();
        return;
      }
      const id = conversationId.current;
      // onopen catches up. Drop a half-open OPEN socket first: openStream
      // leaves one that is not CLOSED in place.
      const source = sourceRef.current;
      if (source) {
        source.close();
        if (sourceRef.current === source) sourceRef.current = null;
      }
      openStream(id);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        closeStream();
        return;
      }
      resume();
    };
    const onOnline = () => {
      resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    const silence = setInterval(() => {
      const source = sourceRef.current;
      const id = conversationId.current;
      if (!source || source.readyState !== EventSource.OPEN || !id) return;
      if (Date.now() - lastActivity.current < STREAM_SILENCE_MS) return;
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
      openStream(id);
    }, 15_000);

    return () => {
      cancelled = true;
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      clearInterval(silence);
      if (threadRetryTimer.current) clearTimeout(threadRetryTimer.current);
      closeStream();
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    };
  // send reads refs and functional setState. Listing it would re-subscribe the
  // stream on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { messages, sending, hasMore, loadingHistory, connectionError, send, loadMore };
}
