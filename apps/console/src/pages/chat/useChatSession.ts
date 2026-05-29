// apps/console/src/pages/chat/useChatSession.ts
import { useState, useRef } from 'react';
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
  // One conversationId per page session — generated on first send and reused.
  const conversationId = useRef<string | null>(null);

  async function send(text: string): Promise<void> {
    if (sending || text.trim().length === 0) return;

    if (!conversationId.current) {
      conversationId.current = crypto.randomUUID();
    }
    const convId = conversationId.current;

    // Optimistic append so the user sees their message immediately.
    setMessages(prev => [...prev, makeMessage('user', text)]);
    setSending(true);

    // Open the SSE stream BEFORE the POST to avoid racing a fast reply.
    const source = new EventSource(
      `/api/kg/chat/stream?conversationId=${encodeURIComponent(convId)}`,
    );
    source.onmessage = (event: MessageEvent<string>) => {
      const statusText = parseSseEvent(event.data);
      if (statusText) {
        setMessages(prev => [...prev, makeMessage('status', statusText)]);
      }
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
      source.close();
      setSending(false);
    }
  }

  return { messages, sending, send };
}
