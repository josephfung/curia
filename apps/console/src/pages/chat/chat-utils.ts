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
  } catch {
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
export function makeMessage(kind: Message['kind'], text: string): Message {
  return { id: crypto.randomUUID(), kind, text };
}
