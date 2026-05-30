// apps/console/src/pages/chat/ChatThread.tsx
import { useEffect, useRef } from 'react';
import { formatTimestamp } from './chat-utils.js';
import type { Message } from './types.js';

interface ChatThreadProps {
  messages: Message[];
  hasMore: boolean;
  loadingHistory: boolean;
  loadMore: () => Promise<void>;
}

export function ChatThread({ messages, hasMore, loadingHistory, loadMore }: ChatThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track message count so auto-scroll fires only when new messages arrive at
  // the bottom — not when older history is prepended at the top.
  const prevMessageCount = useRef(messages.length);

  // Scroll to bottom on new messages. Skips when history is prepended (the
  // message count grows but the last message ID hasn't changed).
  const lastMessageId = useRef<string | undefined>(messages[messages.length - 1]?.id);
  useEffect(() => {
    const currentLastId = messages[messages.length - 1]?.id;
    const countGrew = messages.length > prevMessageCount.current;
    prevMessageCount.current = messages.length;

    // If the last message ID changed, a new message arrived at the bottom.
    if (countGrew && currentLastId !== lastMessageId.current) {
      lastMessageId.current = currentLastId;
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      lastMessageId.current = currentLastId;
    }
  }, [messages]);

  // IntersectionObserver on the top sentinel triggers loadMore when the user
  // scrolls near the top of the thread and older history is available.
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !loadingHistory) {
          // Capture scrollHeight before prepending so we can restore position after.
          const container = scrollRef.current;
          const prevScrollHeight = container?.scrollHeight ?? 0;

          void loadMore().then(() => {
            // After React re-renders the prepended messages, shift scrollTop by
            // the height delta so the user stays at the same visual position.
            if (container) {
              container.scrollTop += container.scrollHeight - prevScrollHeight;
            }
          });
        }
      },
      { root: scrollRef.current, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingHistory, loadMore]);

  return (
    <div
      className="chat-messages"
      ref={scrollRef}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {/* Top sentinel — watched by IntersectionObserver to trigger loadMore. */}
      <div ref={topSentinelRef} className="chat-history-sentinel">
        {loadingHistory && <div className="chat-history-loading">Loading…</div>}
      </div>

      {messages.map((msg) => {
        if (msg.kind === 'status' || msg.kind === 'error') {
          return (
            <div key={msg.id} className={`msg-bubble ${msg.kind}`}>
              {msg.text}
            </div>
          );
        }

        return (
          <div key={msg.id} className={`msg-group ${msg.kind}`}>
            <div className={`msg-bubble ${msg.kind}`}>
              {msg.html ? (
                // Safe: html is produced server-side by markdownToHtml(), which
                // runs escapeHtml() (converting < > & to HTML entities) BEFORE
                // inserting any markup. LLM output such as <script> becomes
                // &lt;script&gt; before bold/italic/code patterns are applied.
                // No raw user input ever reaches dangerouslySetInnerHTML.
                <span dangerouslySetInnerHTML={{ __html: msg.html }} />
              ) : (
                msg.text
              )}
            </div>
            {msg.timestamp && (
              <div className="msg-time">{formatTimestamp(msg.timestamp)}</div>
            )}
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
}
