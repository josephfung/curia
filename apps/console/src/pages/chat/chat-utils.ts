import type { Message } from './types.js';

/**
 * Parses a raw SSE event data string into a human-readable status label,
 * or returns null for events that should not be displayed in the thread.
 * Only skill.invoke events produce visible status messages.
 */
export function parseSseEvent(data: string): string | null {
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
  if (p['type'] === 'skill.invoke') {
    const skill = typeof p['skill'] === 'string' ? p['skill'] : 'skill';
    return `invoking ${skill}`;
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
