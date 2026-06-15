import type { Message, SseEvent, HistoryMessage } from './types.js';

/**
 * Friendly, user-facing text for a message.rejected reason code.
 *
 * Reason codes mirror MessageRejectedEvent.reason in src/bus/events.ts:
 * unknown_sender | provisional_sender | blocked_sender | message_too_large
 * | global_rate_limited | sender_rate_limited. Both rate-limit variants get the
 * same friendly copy; everything else falls back to a generic message naming the
 * reason (the sender-identity reasons can't normally occur on the CEO-only web
 * channel, so a generic message is acceptable for them).
 */
function rejectionText(reason: string): string {
  switch (reason) {
    case 'global_rate_limited':
    case 'sender_rate_limited':
      return 'Rate limit reached. Please wait a moment and try again.';
    case 'message_too_large':
      return 'That message is too large to process.';
    default:
      return `Message rejected (${reason}).`;
  }
}

/**
 * Parses a raw SSE event data string from GET /api/kg/chat/stream into a
 * normalized SseEvent, or null for events the chat UI ignores.
 *
 * Ack-and-stream (#985): the POST only acks, so the `message` event is now the
 * source of truth for the agent's final reply (terminal). `message.rejected` is
 * a terminal error. `skill.invoke` is intermediate progress. Everything else
 * (skill.result, malformed payloads, unknown types) returns null.
 */
export function parseSseEvent(data: string): SseEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch (parseErr) {
    // Non-fatal: malformed SSE data is silently ignored.
    // Log at debug level so it's visible in DevTools when investigating SSE issues.
    console.debug('[parseSseEvent] failed to parse SSE data:', parseErr);
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  switch (p['type']) {
    case 'skill.invoke': {
      const skill = typeof p['skill'] === 'string' ? p['skill'] : 'skill';
      return { kind: 'status', text: `invoking ${skill}` };
    }
    case 'message': {
      const text = typeof p['content'] === 'string' ? p['content'] : '';
      const html = typeof p['html'] === 'string' ? p['html'] : null;
      return { kind: 'reply', text, html };
    }
    case 'message.rejected': {
      const reason = typeof p['reason'] === 'string' ? p['reason'] : 'unknown';
      return { kind: 'rejected', text: rejectionText(reason) };
    }
    default:
      return null;
  }
}

/**
 * Recovery helper for the client watchdog: given a page of chat history (oldest
 * first) and the time we sent the current turn, return the most recent assistant
 * reply that landed at or after the send time — the reply we may have missed if
 * the SSE message event never arrived. Returns null if there's no such reply.
 */
export function pickRecoveredReply(
  items: HistoryMessage[],
  sentAtMs: number,
): { text: string; html: string | null } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i]!;
    if (m.role === 'assistant' && new Date(m.timestamp).getTime() >= sentAtMs) {
      return { text: m.content, html: m.html };
    }
  }
  return null;
}

/** Returns a new Message with a stable random ID. */
export function makeMessage(
  kind: Message['kind'],
  text: string,
  opts?: { html?: string; timestamp?: Date },
): Message {
  return { id: crypto.randomUUID(), kind, text, ...opts };
}

/**
 * Format a Date for display in the chat thread.
 * Shows "Today · 9:24 AM" for messages from today, "May 28 · 9:24 AM" otherwise.
 */
export function formatTimestamp(ts: Date): string {
  const now = new Date();
  const isToday =
    ts.getFullYear() === now.getFullYear() &&
    ts.getMonth() === now.getMonth() &&
    ts.getDate() === now.getDate();

  const time = ts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isToday) return `Today · ${time}`;

  const date = ts.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${date} · ${time}`;
}

/**
 * Escapes HTML in user-supplied text and wraps bare http/https URLs in anchor tags.
 * The result is safe to pass to dangerouslySetInnerHTML: HTML escaping runs first,
 * so no user text can inject markup. The URL regex only matches http/https, blocking
 * javascript: and other non-http schemes.
 */
export function linkifyText(text: string): string {
  // Escape HTML entities first so user text cannot inject markup.
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Wrap bare URLs. The exclusion set [^\s<>"] stops at whitespace and the HTML
  // characters that would break the surrounding attribute or tag context.
  return escaped.replace(
    /https?:\/\/[^\s<>"]+/g,
    url => {
      // Strip trailing sentence punctuation. Balanced bracket pairs (e.g.
      // Wikipedia /wiki/Function_(mathematics)) are only stripped when unmatched.
      let stripped = url.replace(/[.,;:!?'"`]+$/, '');
      while (stripped.endsWith(')')) {
        const opens = (stripped.match(/\(/g) ?? []).length;
        const closes = (stripped.match(/\)/g) ?? []).length;
        if (closes <= opens) break;
        stripped = stripped.slice(0, -1);
      }
      while (stripped.endsWith(']')) {
        const opens = (stripped.match(/\[/g) ?? []).length;
        const closes = (stripped.match(/\]/g) ?? []).length;
        if (closes <= opens) break;
        stripped = stripped.slice(0, -1);
      }
      const suffix = url.slice(stripped.length);
      return `<a href="${stripped}" target="_blank" rel="noopener noreferrer">${stripped}</a>${suffix}`;
    },
  );
}
