// apps/console/src/pages/chat/useChatSession.ts
import { useState, useRef, useEffect } from 'react';
import { apiFetch } from '../../api.js';
import { makeMessage, parseSseEvent } from './chat-utils.js';
import type { Message } from './types.js';

interface ChatSession {
  messages: Message[];
  sending: boolean;
  send: (text: string) => Promise<void>;
}

export function useChatSession(): ChatSession {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  // isSending is a ref so the double-send guard is immune to stale closures.
  const isSending = useRef(false);
  // Holds the active EventSource so cleanup can close it on unmount.
  const sourceRef = useRef<EventSource | null>(null);
  // One conversationId per page session — generated on first send and reused.
  const conversationId = useRef<string | null>(null);

  // Close any in-flight SSE connection when the component unmounts.
  useEffect(() => () => { sourceRef.current?.close(); }, []);

  async function send(text: string): Promise<void> {
    if (isSending.current || text.trim().length === 0) return;

    if (!conversationId.current) {
      conversationId.current = crypto.randomUUID();
    }
    const convId = conversationId.current;

    // Optimistic append so the user sees their message immediately.
    setMessages(prev => [...prev, makeMessage('user', text)]);
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
          setMessages(prev => [...prev, makeMessage('status', statusText)]);
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
        setMessages(prev => [...prev, makeMessage('error', errMsg)]);
        return;
      }

      const raw = await res.json() as unknown;
      if (
        typeof raw !== 'object' ||
        raw === null ||
        typeof (raw as Record<string, unknown>)['reply'] !== 'string'
      ) {
        console.error('[useChatSession] unexpected response shape:', raw);
        setMessages(prev => [...prev, makeMessage('error', 'Received an unexpected response.')]);
        return;
      }
      const data = raw as { reply: string; conversationId: string };
      setMessages(prev => [...prev, makeMessage('agent', data.reply)]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setMessages(prev => [...prev, makeMessage('error', msg)]);
    } finally {
      isSending.current = false;
      source?.close();
      sourceRef.current = null;
      setSending(false);
    }
  }

  return { messages, sending, send };
}
