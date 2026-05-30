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
  // Tracks the ID of the last rendered message and how many messages were
  // visible before the most recent render so we can distinguish three cases:
  //   • empty → initial history load: prev=0, don't scroll (would yank to bottom)
  //   • new user/agent message: prev>0 and last ID changes, scroll to bottom
  //   • history prepended: last ID unchanged, don't scroll
  const prevCount = useRef(0);
  const lastMessageId = useRef<string | undefined>(undefined);

  useEffect(() => {
    const prev = prevCount.current;
    prevCount.current = messages.length;
    const currentLastId = messages[messages.length - 1]?.id;

    if (prev > 0 && currentLastId !== lastMessageId.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    lastMessageId.current = currentLastId;
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
            // Defer until after the browser paints the prepended messages;
            // React's setState is async so scrollHeight hasn't grown yet
            // by the time the promise resolves.
            requestAnimationFrame(() => {
              if (container) {
                container.scrollTop += container.scrollHeight - prevScrollHeight;
              }
            });
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
