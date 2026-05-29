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

    // Open the SSE stream BEFORE the POST to avoid racing a fast reply.
    // withCredentials sends the session cookie, matching apiFetch behavior.
    const source = new EventSource(
      `/api/kg/chat/stream?conversationId=${encodeURIComponent(convId)}`,
      { withCredentials: true },
    );
    sourceRef.current = source;
    source.onmessage = (event: MessageEvent<string>) => {
      const statusText = parseSseEvent(event.data);
      if (statusText) {
        setMessages(prev => [...prev, makeMessage('status', statusText)]);
      }
    };
    source.onerror = () => {
      // SSE failures are non-fatal — the POST response is authoritative.
      // Close immediately to prevent the browser's automatic reconnection loop.
      source.close();
    };

    try {
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
        } catch { /* non-JSON error body — use the status fallback */ }
        setMessages(prev => [...prev, makeMessage('error', errMsg)]);
        return;
      }

      const data = await res.json() as { reply: string; conversationId: string };
      setMessages(prev => [...prev, makeMessage('agent', data.reply)]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setMessages(prev => [...prev, makeMessage('error', msg)]);
    } finally {
      isSending.current = false;
      source.close();
      sourceRef.current = null;
      setSending(false);
    }
  }

  return { messages, sending, send };
}
