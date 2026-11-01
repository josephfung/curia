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

export interface MergeOptions {
  /** The page starts at the beginning of the thread (the server said hasMore false). */
  complete?: boolean;
  /** Client id of the user row this tab is still sending. A replaced thread keeps it. */
  pendingId?: string | null;
}

export interface MergeResult {
  messages: Message[];
  /**
   * No row on screen was in the page and the page does not reach the start
   * of the thread, so the page replaced the thread. The caller resets its
   * older-history cursor to the page.
   */
  replaced: boolean;
}

/** The server id a row is known by: its paired history id, or a history row's own id. */
function serverKey(message: Message): string {
  return message.serverId ?? message.id;
}

/** A page row as it goes on screen: it always carries its server id. */
function fromPage(row: Message): Message {
  return row.serverId ? row : { ...row, serverId: row.id };
}

/** A live row that may still be paired with its saved copy by kind and text. */
function pairable(message: Message): boolean {
  return !message.serverId && (message.kind === 'user' || message.kind === 'agent');
}

/**
 * Fold a history page (oldest first) into the thread already on screen.
 *
 * Server ids anchor the merge. A page row whose id is on screen, either as a
 * history row or as a live row paired earlier, is an anchor. Between two
 * anchors, and after the last one, page rows are matched by kind and text
 * against live rows that have no server id yet. The live copy wins and takes
 * the history id as `serverId`, so the next catch-up anchors on it. An
 * unmatched page row is inserted before the next live row it precedes, so a
 * phone turn stays ahead of the message this tab sent after it. Rows older
 * than every anchor are only kept when something on screen precedes them;
 * otherwise `loadMore` fetches them.
 *
 * Text matching never runs across a gap. When no page row is on screen and
 * the page does not reach the start of the thread, the page replaced the
 * thread (`replaced`): the user row in flight and the status rows after it
 * are kept, and nothing older is guessed at.
 */
export function mergeLiveTail(
  page: Message[],
  live: Message[],
  options: MergeOptions = {},
): MergeResult {
  if (page.length === 0) return { messages: live, replaced: false };
  if (live.length === 0) return { messages: page.map(fromPage), replaced: false };

  const liveIndex = new Map<string, number>();
  live.forEach((message, index) => { liveIndex.set(serverKey(message), index); });
  const onScreen = new Set<string>();
  // [page index, live index], increasing in both.
  const anchors: Array<[number, number]> = [];
  page.forEach((row, j) => {
    const i = liveIndex.get(row.id);
    if (i === undefined) return;
    onScreen.add(row.id);
    const previous = anchors[anchors.length - 1];
    if (previous && i <= previous[1]) return;
    anchors.push([j, i]);
  });

  const fresh = (rows: Message[]) => rows.filter((row) => !onScreen.has(row.id));

  if (anchors.length === 0) {
    if (options.complete) return { messages: foldSegment(page, live, 'append'), replaced: false };
    return { messages: replaceWithPage(page, live, options.pendingId ?? null), replaced: true };
  }

  const out: Message[] = [];
  const [firstPage, firstLive] = anchors[0]!;
  // Live rows up to the last server row before the first anchor stay as they
  // are: they are older than the page.
  let head = -1;
  for (let i = firstLive - 1; i >= 0; i -= 1) {
    if (live[i]!.serverId) { head = i; break; }
  }
  out.push(...live.slice(0, head + 1));
  // With no server row above the first anchor, an unmatched page row before
  // it is older than the screen's oldest history row. loadMore fetches it.
  const headMode = head === -1 && !options.complete ? 'drop' : 'append';
  out.push(...foldSegment(fresh(page.slice(0, firstPage)), live.slice(head + 1, firstLive), headMode));

  anchors.forEach(([j, i], k) => {
    const anchor = live[i]!;
    out.push(anchor.serverId ? anchor : { ...anchor, serverId: page[j]!.id });
    const next = anchors[k + 1];
    const pageSegment = fresh(page.slice(j + 1, next ? next[0] : page.length));
    const liveSegment = live.slice(i + 1, next ? next[1] : live.length);
    out.push(...foldSegment(pageSegment, liveSegment, 'append'));
  });
  return { messages: out, replaced: false };
}

/**
 * Keep `liveSegment` in order. A pairable live row that matches a page row by
 * kind and text consumes it and takes its id as `serverId`. Page rows that
 * sit before that match are inserted first, so they keep the server's order.
 * What is still unmatched at the end is appended. In 'drop' mode, unmatched
 * rows before the first match are older than the screen and are left out.
 */
function foldSegment(
  pageSegment: Message[],
  liveSegment: Message[],
  leftovers: 'append' | 'drop',
): Message[] {
  const out: Message[] = [];
  let cursor = 0;
  let keep = leftovers === 'append';
  for (const row of liveSegment) {
    let matched = -1;
    if (pairable(row)) {
      for (let j = cursor; j < pageSegment.length; j += 1) {
        const candidate = pageSegment[j]!;
        if (candidate.kind === row.kind && candidate.text === row.text) {
          matched = j;
          break;
        }
      }
    }
    if (matched < 0) {
      out.push(row);
      continue;
    }
    if (keep) out.push(...pageSegment.slice(cursor, matched).map(fromPage));
    out.push({ ...row, serverId: pageSegment[matched]!.id });
    cursor = matched + 1;
    keep = true;
  }
  if (keep) out.push(...pageSegment.slice(cursor).map(fromPage));
  return out;
}

/** The page, then the user row in flight (unless the page already has it) and its status rows. */
function replaceWithPage(page: Message[], live: Message[], pendingId: string | null): Message[] {
  const out = page.map(fromPage);
  const pendingIndex = pendingId ? live.findIndex((message) => message.id === pendingId) : -1;
  if (pendingIndex < 0) return out;
  const pending = live[pendingIndex]!;
  let lastUser = -1;
  for (let j = out.length - 1; j >= 0; j -= 1) {
    if (out[j]!.kind === 'user') { lastUser = j; break; }
  }
  if (lastUser >= 0 && out[lastUser]!.text === pending.text) {
    out[lastUser] = { ...pending, serverId: out[lastUser]!.id };
  } else {
    out.push(pending);
  }
  for (const message of live.slice(pendingIndex + 1)) {
    if (message.kind === 'status' || message.kind === 'error') out.push(message);
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
