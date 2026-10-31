// Notification body for a web push (#2341). Plain text, capped, or the
// hidden-preview stand-in. Never markdown.

const PREVIEW_CHARS = 100;
export const HIDDEN_PREVIEW = 'New message from Curia';

export function pushPreview(text: string, hidePreviews: boolean): string {
  if (hidePreviews) return HIDDEN_PREVIEW;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return HIDDEN_PREVIEW;
  if (flat.length <= PREVIEW_CHARS) return flat;
  return `${flat.slice(0, PREVIEW_CHARS - 1)}…`;
}

export type PushStatusClass = 'ok' | 'gone' | 'setup' | 'retry';

/** How one push response is treated. 404/410 are dead. 429/5xx are retried. Other 4xx are setup. */
export function classifyPushStatus(status: number): PushStatusClass {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 410) return 'gone';
  if (status === 429 || status >= 500) return 'retry';
  if (status >= 400 && status < 500) return 'setup';
  return 'retry';
}

export function pushRetryDelayMs(attempt: number): number {
  const step = Math.min(Math.max(attempt, 0), 3);
  return 1000 * 2 ** step;
}
