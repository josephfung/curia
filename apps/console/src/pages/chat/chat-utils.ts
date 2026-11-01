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
 * Parses a raw SSE event data string from GET /api/chat/stream into a
 * normalized SseEvent, or null for events the chat UI ignores.
 *
 * Ack-and-stream (#985): the POST only acks, so the `message` event is now the
 * source of truth for the agent's final reply (terminal). `message.rejected` is
 * a terminal error. `tool.invoke` is intermediate progress. Everything else
 * (tool.result, malformed payloads, unknown types) returns null.
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
    case 'tool.invoke': {
      const tool = typeof p['tool'] === 'string' ? p['tool'] : 'tool';
      return { kind: 'status', text: `invoking ${tool}` };
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
    case 'ping':
      return null;
    case 'user.message': {
      const text = typeof p['content'] === 'string' ? p['content'] : '';
      const clientMessageId = typeof p['client_message_id'] === 'string' ? p['client_message_id'] : null;
      return { kind: 'user', text, clientMessageId };
    }
    default:
      return null;
  }
}

/**
 * Recovery helper for the client watchdog: given a page of chat history (oldest
 * first), return the assistant reply to the most recent user turn — i.e. the most
 * recent assistant message positioned AFTER the last user message. Returns null
 * when the latest turn is still unanswered (history ends on a user message) or
 * there is no user turn yet.
 *
 * Uses message ORDERING, not wall-clock timestamps. The previous version compared
 * a server-written timestamp against a client-side Date.now(), which a skewed
 * client clock could trip — a valid reply judged "too old" and silently dropped.
 * The server persists the inbound user turn (runtime addTurn) before producing a
 * reply, so "an assistant message after the last user message" reliably identifies
 * the reply to the current turn without depending on either clock. (#985)
 */
export function pickRecoveredReply(
  items: HistoryMessage[],
): { text: string; html: string | null } | null {
  // Find the most recent user message; its reply (if any) sits after it.
  let lastUserIdx = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return null;

  for (let i = items.length - 1; i > lastUserIdx; i--) {
    const m = items[i]!;
    if (m.role === 'assistant') {
      return { text: m.content, html: m.html };
    }
  }
  return null;
}

/** Returns a new Message with a stable random ID, or `opts.id` when the caller has one. */
export function makeMessage(
  kind: Message['kind'],
  text: string,
  opts?: { id?: string; html?: string; timestamp?: Date },
): Message {
  const { id, ...rest } = opts ?? {};
  return { id: id ?? crypto.randomUUID(), kind, text, ...rest };
}

/**
 * Delay before the next SSE reconnect. Attempt 0 waits 1s, then doubles, and
 * stops growing at 30s.
 */
export function nextReconnectDelayMs(attempt: number): number {
  const step = Math.min(Math.max(attempt, 0), 5);
  return Math.min(30_000, 1000 * 2 ** step);
}

/**
 * Fold a history page into the thread already on screen.
 *
 * The prefix of `live` (rows `loadMore` already pulled, or an older page) stays.
 * A page row whose id is already on screen is dropped. The rest is matched, by
 * kind and text, only against the live tail — echoes and `makeMessage` ids —
 * so an older "ok" cannot pair with a new one. The live copy wins. An unmatched
 * history row is inserted before the next tail row it precedes, so a phone turn
 * stays ahead of the message this tab sent after it. `pairedOnto` records a
 * history id that was folded onto a live id.
 */
export function mergeLiveTail(
  history: Message[],
  live: Message[],
  pairedOnto?: Map<string, string>,
): Message[] {
  if (live.length === 0) return history;
  if (history.length === 0) return live;

  const historyIds = new Set(history.map((message) => message.id));
  const liveIds = new Set(live.map((message) => message.id));
  let firstShared = -1;
  let lastShared = -1;
  for (let i = 0; i < live.length; i += 1) {
    if (!historyIds.has(live[i]!.id)) continue;
    if (firstShared === -1) firstShared = i;
    lastShared = i;
  }

  const incoming = history.filter((message) => !liveIds.has(message.id));
  if (firstShared === -1) return foldByText(history, live, pairedOnto);

  const prefix = live.slice(0, firstShared);
  const overlap = live.slice(firstShared, lastShared + 1);
  const tail = live.slice(lastShared + 1);
  return [...prefix, ...overlap, ...appendUnmatched(incoming, tail, pairedOnto)];
}

/**
 * Keep `tail` in order. A tail row that matches an incoming row by kind and
 * text consumes it (the tail copy wins). Incoming rows that sit before that
 * match are inserted first, so they keep the server's order. Whatever is
 * still unmatched is appended.
 */
function appendUnmatched(
  incoming: Message[],
  tail: Message[],
  pairedOnto?: Map<string, string>,
): Message[] {
  const used = new Set<number>();
  let cursor = 0;
  const out: Message[] = [];
  for (const live of tail) {
    if (live.kind !== 'status') {
      for (let j = cursor; j < incoming.length; j += 1) {
        const row = incoming[j]!;
        if (row.kind === live.kind && row.text === live.text) {
          for (let k = cursor; k < j; k += 1) {
            if (!used.has(k)) out.push(incoming[k]!);
            used.add(k);
          }
          used.add(j);
          pairedOnto?.set(row.id, live.id);
          cursor = j + 1;
          break;
        }
      }
    }
    out.push(live);
  }
  for (let j = 0; j < incoming.length; j += 1) {
    if (!used.has(j)) out.push(incoming[j]!);
  }
  return out;
}

/** Match `page` onto `tail` by kind and text. The tail copy wins. Status rows stay. */
function foldByText(
  page: Message[],
  tail: Message[],
  pairedOnto?: Map<string, string>,
): Message[] {
  const usedTail = new Set<number>();
  const out: Message[] = [];
  let cursor = 0;
  for (const row of page) {
    let matched = -1;
    for (let j = cursor; j < tail.length; j += 1) {
      const live = tail[j]!;
      if (live.kind === 'status') continue;
      if (live.kind === row.kind && live.text === row.text) {
        matched = j;
        break;
      }
    }
    if (matched < 0) {
      out.push(row);
      continue;
    }
    pairedOnto?.set(row.id, tail[matched]!.id);
    for (let j = cursor; j <= matched; j += 1) {
      const live = tail[j]!;
      if (j === matched || live.kind === 'status') out.push(live);
      usedTail.add(j);
    }
    cursor = matched + 1;
  }
  for (let j = 0; j < tail.length; j += 1) {
    if (!usedTail.has(j)) out.push(tail[j]!);
  }
  return out;
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
