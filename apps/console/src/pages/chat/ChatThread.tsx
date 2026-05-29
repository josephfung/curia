// apps/console/src/pages/chat/ChatThread.tsx
import { useEffect, useRef } from 'react';
import type { Message } from './types.js';

interface ChatThreadProps {
  messages: Message[];
}

export function ChatThread({ messages }: ChatThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Scroll to the latest message whenever the list grows.
  useEffect(() => {
    if (messages.length === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="chat-messages">
      {messages.map(msg => (
        <div key={msg.id} className={`msg-bubble ${msg.kind}`}>
          {msg.text}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
