// apps/console/src/pages/chat/useChatSession.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import { apiFetch } from '../../api.js';
import { makeMessage, parseSseEvent, pickRecoveredReply } from './chat-utils.js';
import type { Message, HistoryMessage } from './types.js';

// localStorage key for persisting the conversationId across page reloads.
const CONV_ID_KEY = 'curia:chat:conversationId';
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
// Shown when recovery ran, the /history fetch succeeded, but no reply has landed
// yet. Phrased conditionally ("if it arrives") because we genuinely can't tell a
// slow turn from a dropped one (e.g. an email-skill suppressed-duplicate turn that
// produces no chat reply at all) — so we don't promise a reply that may never come.
const STILL_WORKING_TEXT =
  'This is taking longer than usual. The reply will appear here if it arrives — you can also resend.';
// Shown when recovery itself failed (the /history fetch errored or returned non-ok,
// e.g. an expired session or a server error). We have no basis to claim progress,
// so we tell the user the status is unknown rather than implying a reply is coming.
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

  // isSending and isLoadingMore are refs so their guards are immune to stale closures.
  // Using refs rather than state prevents the IntersectionObserver from tearing
  // down and re-mounting on every loadMore cycle (which could cause a double-fetch
  // during the brief window when state hasn't propagated to the observer's closure).
  const isSending = useRef(false);
  const isLoadingMore = useRef(false);
  // Holds the active EventSource so cleanup can close it on unmount.
  const sourceRef = useRef<EventSource | null>(null);
  // Holds the in-flight reply watchdog timer so cleanup can clear it on unmount
  // (otherwise a turn that unmounts mid-flight leaves a up-to-5-minute timer that
  // later fires a post-unmount /history fetch + setState). See send() below.
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Close any in-flight SSE connection and clear the reply watchdog when the
  // component unmounts, so neither survives to fire after teardown.
  useEffect(() => () => {
    sourceRef.current?.close();
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
  }, []);

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

    // Close any stream left open by a prior turn's soft-recovery path, and clear
    // any pending watchdog, before starting a new one — never leak either.
    sourceRef.current?.close();
    sourceRef.current = null;
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }

    const sentAt = Date.now();
    // Optimistic append so the user sees their message immediately.
    setMessages((prev) => [
      ...prev,
      makeMessage('user', text, { timestamp: new Date() }),
    ]);
    isSending.current = true;
    setSending(true);

    let source: EventSource | undefined;
    let settled = false;
    // Guards runRecovery so it runs at most once per turn — both the watchdog
    // timeout and a fatal stream close (onerror) can trigger it, and we never
    // want two recovery passes (which could post two notices).
    let recoveryStarted = false;

    // Unlock the composer (and stop the watchdog) without touching the stream —
    // used by the soft-recovery path so a late reply can still render. The
    // watchdog lives in a ref so the unmount cleanup can also clear it.
    const unlock = () => {
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      isSending.current = false;
      setSending(false);
    };
    // Fully finish the turn: unlock and close the stream. Idempotent.
    const finalize = () => {
      if (settled) return;
      settled = true;
      unlock();
      source?.close();
      sourceRef.current = null;
    };

    // Recovery: fetch one history page and render a reply the SSE stream may have
    // missed. Triggered by the watchdog timeout OR a fatal stream close. Three
    // outcomes, each with honest feedback:
    //   1. reply found      → render it + finalize.
    //   2. fetch failed      → "couldn't confirm status, resend" (status unknown).
    //   3. fetch ok, no reply → soft "taking longer" notice, leave the stream open.
    // Runs at most once per turn (recoveryStarted guard).
    const runRecovery = async () => {
      if (recoveryStarted || settled) return;
      recoveryStarted = true;

      let fetchOk = false;
      try {
        const res = await apiFetch(
          `/api/kg/chat/history?conversationId=${encodeURIComponent(convId)}&limit=${HISTORY_PAGE_SIZE}`,
        );
        if (res.ok) {
          fetchOk = true;
          const data = (await res.json()) as HistoryResponse;
          const recovered = pickRecoveredReply(data.messages, sentAt);
          if (recovered) {
            setMessages((prev) => [
              ...prev,
              makeMessage('agent', recovered.text, { html: recovered.html ?? undefined, timestamp: new Date() }),
            ]);
            finalize();
            return;
          }
        } else {
          console.error('[useChatSession] recovery history fetch non-ok:', res.status);
        }
      } catch (err) {
        console.error('[useChatSession] recovery history fetch failed:', err);
      }

      if (!fetchOk) {
        // Recovery itself failed — we can't claim progress. Tell the user the
        // status is unknown and finalize (close the dead stream; nothing more is
        // coming through it).
        setMessages((prev) => [...prev, makeMessage('error', RECOVERY_FAILED_TEXT)]);
        finalize();
        return;
      }

      // Fetch succeeded but no reply yet — soft notice, unlock, keep the stream
      // open so a late reply still renders. This open stream is closed by one of:
      // a late SSE reply (onmessage → finalize), the next send() (closes the prior
      // stream up top), or unmount cleanup. That closure contract is non-local.
      setMessages((prev) => [...prev, makeMessage('status', STILL_WORKING_TEXT)]);
      unlock();
    };

    try {
      // Open the SSE stream and wait for it to connect BEFORE the POST, so a fast
      // reply broadcast can't race past an unregistered stream. withCredentials
      // sends the session cookie, matching apiFetch behavior.
      source = new EventSource(
        `/api/kg/chat/stream?conversationId=${encodeURIComponent(convId)}`,
        { withCredentials: true },
      );
      sourceRef.current = source;

      source.onmessage = (event: MessageEvent<string>) => {
        const parsed = parseSseEvent(event.data);
        if (!parsed) return;
        if (parsed.kind === 'status') {
          setMessages((prev) => [...prev, makeMessage('status', parsed.text)]);
          return;
        }
        if (parsed.kind === 'reply') {
          // Terminal: the agent's final reply for this turn.
          setMessages((prev) => [
            ...prev,
            makeMessage('agent', parsed.text, { html: parsed.html ?? undefined, timestamp: new Date() }),
          ]);
          finalize();
          return;
        }
        // parsed.kind === 'rejected' — terminal error.
        setMessages((prev) => [...prev, makeMessage('error', parsed.text)]);
        finalize();
      };

      source.onerror = (event) => {
        // EventSource auto-reconnects on transient errors (readyState CONNECTING) —
        // leave those alone so a reconnect can still deliver the terminal event.
        // But on a FATAL close (readyState CLOSED, e.g. an expired session 401 or a
        // dropped server) the browser will NOT reconnect: the terminal event can
        // never arrive over this stream. Don't make the user wait out the full
        // watchdog — recover immediately so a missed reply (or an honest "status
        // unknown" notice) surfaces in seconds rather than minutes.
        console.error('[useChatSession] SSE stream error (readyState=%d):', source?.readyState, event);
        if (source?.readyState === EventSource.CLOSED && !settled) {
          if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
          void runRecovery();
        }
      };

      // Wait for the stream to open, but don't block forever — if it doesn't open
      // within SSE_OPEN_TIMEOUT_MS, POST anyway and let the watchdog recover.
      await new Promise<void>((resolve) => {
        if (!source) { resolve(); return; }
        if (source.readyState === EventSource.OPEN) { resolve(); return; }
        const to = setTimeout(resolve, SSE_OPEN_TIMEOUT_MS);
        source.onopen = () => { clearTimeout(to); resolve(); };
      });

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
        finalize();
        return;
      }

      // 202 ack received. The reply arrives over SSE; arm the watchdog in case it
      // never does (suppressed-duplicate turn or agent crash). Guard on !settled:
      // a fast reply can fire between the onopen gate and the POST resolving, in
      // which case the turn is already finalized and arming the watchdog would
      // later append a duplicate of the already-rendered reply via /history.
      if (!settled) {
        watchdogRef.current = setTimeout(() => { void runRecovery(); }, REPLY_WATCHDOG_MS);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setMessages((prev) => [...prev, makeMessage('error', msg)]);
      finalize();
    }
    // NOTE: no finally that clears sending/closes the stream — the turn is
    // finished by the SSE terminal event, the watchdog, or an error path above.
  }

  return { messages, sending, hasMore, loadingHistory, send, loadMore };
}
