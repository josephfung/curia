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
