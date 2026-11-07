// Notification body for a web push (#2341). Plain text, capped on a code-point
// and word boundary, or the hidden-preview stand-in. Never markdown.

const PREVIEW_CHARS = 100;
export const HIDDEN_PREVIEW = 'New message from Curia';

// The text can come from outside (an inbound message), so every pattern below must
// stay linear. A link's label and destination stop at the next `[`, and an italic
// span stops at the next marker, and a list marker's indent never crosses a line:
// otherwise a long run of unclosed `[`, `[a](`, ` *a` or blank lines makes each
// match attempt scan to the end of the text (quadratic).
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^[\]]*\]\([^)[]*\)/g, ' ')
    .replace(/\[([^[\]]+)\]\([^)[]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)\*([^\s*](?:[^*\n]*[^\s*])?)\*(?=\s|$)/g, '$1$2')
    .replace(/(^|\s)_([^\s_](?:[^_\n]*[^\s_])?)_(?=\s|$)/g, '$1$2')
    .replace(/^[^\S\n]*[-*+]\s+/gm, '')
    .replace(/^[^\S\n]*\d+\.\s+/gm, '');
}

export function pushPreview(text: string, hidePreviews: boolean): string {
  if (hidePreviews) return HIDDEN_PREVIEW;
  const flat = stripMarkdown(text).replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return HIDDEN_PREVIEW;
  const chars = Array.from(flat);
  if (chars.length <= PREVIEW_CHARS) return flat;
  let cut = PREVIEW_CHARS - 1;
  const head = chars.slice(0, cut).join('');
  const space = head.lastIndexOf(' ');
  if (space >= 40) cut = Array.from(head.slice(0, space)).length;
  return `${chars.slice(0, cut).join('').trimEnd()}…`;
}

export type PushStatusClass = 'ok' | 'gone' | 'setup' | 'retry' | 'failed';

/**
 * How one push response is treated. 404/410 are dead. 429 and 5xx are retried
 * inside the push phase, after Retry-After when the service sends one and the
 * round's backoff otherwise. Other 4xx are setup. Status 0 and anything else are
 * a local failure: one attempt, then stop. They are not retried forever.
 */
export function classifyPushStatus(status: number): PushStatusClass {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 410) return 'gone';
  if (status === 429) return 'retry';
  if (status >= 400 && status < 500) return 'setup';
  if (status >= 500 && status < 600) return 'retry';
  return 'failed';
}

/** Cap a Retry-After hint at five seconds. Absent or unreadable means no wait. */
export function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000);
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return undefined;
  return Math.min(Math.max(when - Date.now(), 0), 5_000);
}
