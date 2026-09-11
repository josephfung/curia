import { describe, it, expect, vi } from 'vitest';
import {
  fetchChatHistoryPage,
  toChatHistoryMessage,
  type ChatHistoryRow,
} from '../../../src/channels/http/chat-history-page.js';
import { VOICE_GREETING_USER_MESSAGE } from '../../../src/channels/voice/greeting.js';
import { LLM_FAILURE_TURN_CONTENT, LLM_FAILURE_USER_MESSAGE } from '../../../src/memory/llm-failure-turn.js';

function row(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  seconds: number,
): ChatHistoryRow {
  return {
    id,
    role,
    content,
    created_at: new Date(`2026-01-01T00:00:${String(seconds).padStart(2, '0')}Z`),
  };
}

function loadFrom(all: ChatHistoryRow[]) {
  const newestFirst = [...all].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  return vi.fn(async (before: Date | undefined, fetchLimit: number): Promise<ChatHistoryRow[]> => {
    const filtered = before
      ? newestFirst.filter((r) => r.created_at.getTime() < before.getTime())
      : newestFirst;
    return filtered.slice(0, fetchLimit);
  });
}

describe('toChatHistoryMessage', () => {
  it('rewrites LLM-failure marker turns to the user-facing error text', () => {
    const message = toChatHistoryMessage(
      row('1', 'assistant', LLM_FAILURE_TURN_CONTENT, 1),
      (content) => `<p>${content}</p>`,
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
        { id: 's', role: 'system', content: 'summary', created_at: new Date() },
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
    const page = await fetchChatHistoryPage({
      limit: 3,
      load: loadFrom(rows),
      renderAssistantHtml: (c) => c,
    });
    expect(page.messages.map((m) => m.content)).toEqual(['c', 'd', 'e']);
    expect(page.messages).toHaveLength(3);
    expect(page.hasMore).toBe(true);
  });

  it('sets hasMore false when display messages exhaust', async () => {
    const rows = [
      row('1', 'user', 'a', 0),
      row('2', 'assistant', 'b', 1),
    ];
    const page = await fetchChatHistoryPage({
      limit: 3,
      load: loadFrom(rows),
      renderAssistantHtml: (c) => c,
    });
    expect(page.messages.map((m) => m.content)).toEqual(['a', 'b']);
    expect(page.hasMore).toBe(false);
  });

  it('does not return an empty page when the first raw batch is entirely filtered (#1775)', async () => {
    // Six newest rows are voice cues (a full first batch at limit=2, batchSize=6).
    // Older displayable turns must still be returned.
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
      renderAssistantHtml: (c) => c,
    });

    expect(page.messages.map((m) => m.content)).toEqual(['hello', 'hi']);
    expect(page.messages).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    expect(load.mock.calls.length).toBeGreaterThan(1);
  });

  it('fills to limit after dropping paired voice greeting cues', async () => {
    const rows: ChatHistoryRow[] = [];
    // Newest 6 rows: three cue+greeting pairs, then four real turns.
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
      renderAssistantHtml: (c) => c,
    });

    expect(page.messages).toHaveLength(4);
    expect(page.messages.every((m) => m.content !== VOICE_GREETING_USER_MESSAGE)).toBe(true);
    expect(page.hasMore).toBe(true);
  });
});
