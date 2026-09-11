import { describe, it, expect, vi } from 'vitest';
import {
  fetchChatHistoryPage,
  toChatHistoryMessage,
  CHAT_HISTORY_MAX_ROWS_SCANNED,
  type ChatHistoryCursor,
  type ChatHistoryMessage,
  type ChatHistoryRow,
} from '../../../../src/channels/http/chat-history-page.js';
import { VOICE_GREETING_USER_MESSAGE } from '../../../../src/channels/voice/greeting.js';
import { LLM_FAILURE_TURN_CONTENT, LLM_FAILURE_USER_MESSAGE } from '../../../../src/memory/llm-failure-turn.js';

function isoFromDate(d: Date): string {
  return d.toISOString().replace(/Z$/, '000Z');
}

function row(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  seconds: number,
  createdAtIso?: string,
): ChatHistoryRow {
  const created_at = new Date(`2026-01-01T00:00:${String(seconds).padStart(2, '0')}Z`);
  return {
    id,
    role,
    content,
    created_at,
    created_at_iso: createdAtIso ?? isoFromDate(created_at),
  };
}

function compareKey(a: { created_at_iso: string; id: string }, b: { created_at_iso: string; id: string }): number {
  if (a.created_at_iso !== b.created_at_iso) {
    return a.created_at_iso < b.created_at_iso ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function loadFrom(all: ChatHistoryRow[]) {
  const newestFirst = [...all].sort((a, b) => compareKey(b, a));
  return vi.fn(async (
    cursor: ChatHistoryCursor | undefined,
    fetchLimit: number,
  ): Promise<ChatHistoryRow[]> => {
    const filtered = cursor
      ? newestFirst.filter((r) => {
        const cmp = compareKey(r, { created_at_iso: cursor.createdAtIso, id: cursor.id ?? '' });
        return cmp < 0;
      })
      : newestFirst;
    return filtered.slice(0, fetchLimit);
  });
}

describe('toChatHistoryMessage', () => {
  it('rewrites LLM-failure marker turns to the user-facing error text', () => {
    const message = toChatHistoryMessage(
      row('1', 'assistant', LLM_FAILURE_TURN_CONTENT, 1),
      (content: string) => `<p>${content}</p>`,
    );
    expect(message?.content).toBe(LLM_FAILURE_USER_MESSAGE);
    expect(message?.html).toBe(`<p>${LLM_FAILURE_USER_MESSAGE}</p>`);
  });

  it('drops the synthetic voice greeting cue', () => {
    expect(
      toChatHistoryMessage(row('1', 'user', VOICE_GREETING_USER_MESSAGE, 0), () => ''),
    ).toBeNull();
  });

  it('drops system turns', () => {
    expect(
      toChatHistoryMessage(
        {
          id: 's',
          role: 'system',
          content: 'summary',
          created_at: new Date(),
          created_at_iso: '2026-01-01T00:00:00.000000Z',
        },
        () => '',
      ),
    ).toBeNull();
  });
});

describe('fetchChatHistoryPage', () => {
  it('returns exactly limit display messages and hasMore when more exist', async () => {
    const rows = [
      row('1', 'user', 'a', 0),
      row('2', 'assistant', 'b', 1),
      row('3', 'user', 'c', 2),
      row('4', 'assistant', 'd', 3),
      row('5', 'user', 'e', 4),
    ];
    const load = loadFrom(rows);
    const page = await fetchChatHistoryPage({
      limit: 3,
      load,
      renderAssistantHtml: (c: string) => c,
    });
    expect(page.messages.map((m: ChatHistoryMessage) => m.content)).toEqual(['c', 'd', 'e']);
    expect(page.messages).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(load.mock.calls[0]![1]).toBe(4);
  });

  it('sets hasMore false when display messages exhaust', async () => {
    const rows = [
      row('1', 'user', 'a', 0),
      row('2', 'assistant', 'b', 1),
    ];
    const page = await fetchChatHistoryPage({
      limit: 3,
      load: loadFrom(rows),
      renderAssistantHtml: (c: string) => c,
    });
    expect(page.messages.map((m: ChatHistoryMessage) => m.content)).toEqual(['a', 'b']);
    expect(page.hasMore).toBe(false);
  });

  it('does not return an empty page when the first raw batch is entirely filtered (#1775)', async () => {
    const newestCues: ChatHistoryRow[] = [];
    for (let i = 0; i < 6; i++) {
      newestCues.push(row(`cue-${i}`, 'user', VOICE_GREETING_USER_MESSAGE, 10 + i));
    }
    const all = [
      row('keep-1', 'user', 'hello', 0),
      row('keep-2', 'assistant', 'hi', 1),
      ...newestCues,
    ];

    const load = loadFrom(all);
    const page = await fetchChatHistoryPage({
      limit: 2,
      load,
      renderAssistantHtml: (c: string) => c,
    });

    expect(page.messages.map((m: ChatHistoryMessage) => m.content)).toEqual(['hello', 'hi']);
    expect(page.messages).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    expect(load.mock.calls.length).toBeGreaterThan(1);
    for (const call of load.mock.calls) {
      expect(call[1]).toBe(3);
    }
  });

  it('fills to limit after dropping paired voice greeting cues', async () => {
    const rows: ChatHistoryRow[] = [];
    let t = 0;
    for (let i = 0; i < 4; i++) {
      rows.push(row(`u-${i}`, 'user', `q${i}`, t++));
      rows.push(row(`a-${i}`, 'assistant', `a${i}`, t++));
    }
    for (let i = 0; i < 3; i++) {
      rows.push(row(`cue-${i}`, 'user', VOICE_GREETING_USER_MESSAGE, t++));
      rows.push(row(`greet-${i}`, 'assistant', `hello ${i}`, t++));
    }

    const page = await fetchChatHistoryPage({
      limit: 4,
      load: loadFrom(rows),
      renderAssistantHtml: (c: string) => c,
    });

    expect(page.messages).toHaveLength(4);
    expect(page.messages.every((m: ChatHistoryMessage) => m.content !== VOICE_GREETING_USER_MESSAGE)).toBe(true);
    expect(page.hasMore).toBe(true);
  });

  it('does not skip a same-millisecond earlier row when the cursor Date would truncate (#1775)', async () => {
    const newestCue = row(
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'user',
      VOICE_GREETING_USER_MESSAGE,
      0,
      '2026-01-01T12:00:00.123500Z',
    );
    newestCue.created_at = new Date('2026-01-01T12:00:00.123Z');
    const later = row(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'user',
      VOICE_GREETING_USER_MESSAGE,
      0,
      '2026-01-01T12:00:00.123456Z',
    );
    later.created_at = new Date('2026-01-01T12:00:00.123Z');
    const earlier = row(
      '00000000-0000-4000-8000-000000000001',
      'assistant',
      'survived',
      0,
      '2026-01-01T12:00:00.123100Z',
    );
    earlier.created_at = new Date('2026-01-01T12:00:00.123Z');

    const truncatedLoad = vi.fn(async (
      cursor: ChatHistoryCursor | undefined,
      fetchLimit: number,
    ): Promise<ChatHistoryRow[]> => {
      const newestFirst = [newestCue, later, earlier];
      if (!cursor) return newestFirst.slice(0, fetchLimit);
      const filtered = newestFirst.filter((r) => {
        const cmp = compareKey(r, { created_at_iso: cursor.createdAtIso, id: cursor.id ?? '' });
        return cmp < 0;
      });
      return filtered.slice(0, fetchLimit);
    });

    const page = await fetchChatHistoryPage({
      limit: 1,
      load: truncatedLoad,
      renderAssistantHtml: (c: string) => c,
    });

    expect(page.messages.map((m: ChatHistoryMessage) => m.content)).toEqual(['survived']);
    expect(truncatedLoad.mock.calls.length).toBeGreaterThan(1);
    const secondCursor = truncatedLoad.mock.calls[1]![0];
    expect(secondCursor?.createdAtIso).toBe('2026-01-01T12:00:00.123456Z');
    expect(secondCursor?.id).toBe(later.id);
  });

  it(`stops scanning after ${CHAT_HISTORY_MAX_ROWS_SCANNED} raw rows once some display messages exist`, async () => {
    const rows: ChatHistoryRow[] = [
      row('keep', 'assistant', 'found', 0, '2026-01-01T02:00:00.000000Z'),
    ];
    for (let i = 0; i < CHAT_HISTORY_MAX_ROWS_SCANNED + 50; i++) {
      rows.push(row(
        `cue-${i}`,
        'user',
        VOICE_GREETING_USER_MESSAGE,
        0,
        `2026-01-01T01:00:00.${String(i).padStart(6, '0')}Z`,
      ));
    }

    const load = loadFrom(rows);
    const page = await fetchChatHistoryPage({
      limit: 1,
      load,
      renderAssistantHtml: (c: string) => c,
    });

    expect(page.messages.map((m: ChatHistoryMessage) => m.content)).toEqual(['found']);
    expect(load.mock.calls.length).toBeGreaterThan(1);
    expect(load.mock.calls.length).toBeLessThan(CHAT_HISTORY_MAX_ROWS_SCANNED / 2 + 5);
  });
});
