import { describe, it, expect } from 'vitest';
import { formatOutboundMemo, extractRecentMemos, buildContextPreamble, OUTBOUND_MEMO_PREFIX } from '../../../src/dispatch/context-memo.js';
import type { ConversationTurn } from '../../../src/memory/working-memory.js';

describe('formatOutboundMemo', () => {
  it('produces a structured memo with all fields', () => {
    const memo = formatOutboundMemo({
      conversationId: 'signal:+14155552671',
      content: 'You have 3 held emails. Want me to process them?',
      taskEventId: 'evt-abc123',
    });

    expect(memo).toContain(OUTBOUND_MEMO_PREFIX);
    expect(memo).toContain('source_conversation: signal:+14155552671');
    expect(memo).toContain('message_preview: You have 3 held emails. Want me to process them?');
    expect(memo).toContain('task_type: coordinator-response');
    expect(memo).toContain('key_ids: task:evt-abc123');
    expect(memo).toContain('expected_reply: User may reply to this message');
  });

  it('truncates message_preview at 200 chars with ellipsis', () => {
    const longContent = 'A'.repeat(250);
    const memo = formatOutboundMemo({
      conversationId: 'signal:+14155552671',
      content: longContent,
      taskEventId: 'evt-1',
    });

    const previewLine = memo.split('\n').find(l => l.startsWith('message_preview:'));
    expect(previewLine).toBe(`message_preview: ${'A'.repeat(200)}…`);
  });

  it('does not add ellipsis when content fits within 200 chars', () => {
    const shortContent = 'Hello there';
    const memo = formatOutboundMemo({
      conversationId: 'signal:+14155552671',
      content: shortContent,
      taskEventId: 'evt-1',
    });

    const previewLine = memo.split('\n').find(l => l.startsWith('message_preview:'));
    expect(previewLine).toBe('message_preview: Hello there');
  });

  it('omits key_ids line when taskEventId is undefined', () => {
    const memo = formatOutboundMemo({
      conversationId: 'signal:+14155552671',
      content: 'Hello',
      taskEventId: undefined,
    });

    expect(memo).not.toContain('key_ids:');
  });
});

describe('extractRecentMemos', () => {
  function makeTurn(content: string): ConversationTurn {
    return { role: 'system', content };
  }

  it('extracts memos from system turns matching the prefix', () => {
    const recentMemo = `${OUTBOUND_MEMO_PREFIX}${new Date().toISOString()}]\nsource_conversation: signal:+1\nmessage_preview: hello\ntask_type: coordinator-response\nexpected_reply: User may reply to this message`;
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'Hi' },
      makeTurn(recentMemo),
      { role: 'assistant', content: 'Hello!' },
    ];

    const result = extractRecentMemos(turns, 86_400_000);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(recentMemo);
  });

  it('excludes memos older than the TTL', () => {
    const oldDate = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const oldMemo = `${OUTBOUND_MEMO_PREFIX}${oldDate}]\nsource_conversation: signal:+1\nmessage_preview: old\ntask_type: coordinator-response\nexpected_reply: User may reply to this message`;
    const turns: ConversationTurn[] = [makeTurn(oldMemo)];

    const result = extractRecentMemos(turns, 86_400_000);
    expect(result).toHaveLength(0);
  });

  it('excludes non-system turns and system turns without the memo prefix', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: `${OUTBOUND_MEMO_PREFIX}fake` },
      { role: 'system', content: '[Conversation summary]\nSome summary text' },
    ];

    const result = extractRecentMemos(turns, 86_400_000);
    expect(result).toHaveLength(0);
  });

  it('returns multiple memos in chronological order', () => {
    const t1 = new Date(Date.now() - 3600_000).toISOString();
    const t2 = new Date().toISOString();
    const memo1 = `${OUTBOUND_MEMO_PREFIX}${t1}]\nmessage_preview: first`;
    const memo2 = `${OUTBOUND_MEMO_PREFIX}${t2}]\nmessage_preview: second`;
    const turns: ConversationTurn[] = [makeTurn(memo1), makeTurn(memo2)];

    const result = extractRecentMemos(turns, 86_400_000);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('first');
    expect(result[1]).toContain('second');
  });
});

describe('buildContextPreamble', () => {
  it('wraps memos in preamble header and separator, then appends original content', () => {
    const memos = ['[OUTBOUND CONTEXT — 2026-05-08T14:00:00Z]\nmessage_preview: hello'];
    const result = buildContextPreamble(memos, 'User says hi');

    expect(result).toContain('[PRIOR OUTBOUND CONTEXT — this is what you last sent on this channel]');
    expect(result).toContain('message_preview: hello');
    expect(result).toContain('User says hi');
    expect(result).toContain('---');
  });

  it('includes multiple memos separated by ---', () => {
    const memos = [
      '[OUTBOUND CONTEXT — 2026-05-08T14:00:00Z]\nmessage_preview: first',
      '[OUTBOUND CONTEXT — 2026-05-08T15:00:00Z]\nmessage_preview: second',
    ];
    const result = buildContextPreamble(memos, 'Reply');

    expect(result).toContain('message_preview: first');
    expect(result).toContain('message_preview: second');
  });

  it('returns null when memos array is empty', () => {
    const result = buildContextPreamble([], 'Hello');
    expect(result).toBeNull();
  });
});
