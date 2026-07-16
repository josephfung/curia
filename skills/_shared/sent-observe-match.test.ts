import { describe, it, expect } from 'vitest';
import {
  matchDraftToSent,
  matchTasksToSent,
  formatDiffBlock,
  type DraftSnapshotLike,
  type SentMessageLike,
} from './sent-observe-match.js';

const baseSent: SentMessageLike = {
  id: 'msg-1',
  threadId: 'thread-1',
  subject: 'Re: Follow up',
  to: [{ email: 'alice@example.com' }],
  cc: [],
  date: 1_720_000_100,
  snippet: 'Following up on our chat',
};

const baseSnap: DraftSnapshotLike = {
  draftId: 'draft-1',
  threadId: 'thread-1',
  subject: 'Re: Follow up',
  recipients: { to: [{ email: 'alice@example.com' }], cc: [] },
  body: 'Thanks Alice — following up.',
  createdAt: '2024-07-03T00:00:00.000Z',
};

describe('matchDraftToSent', () => {
  it('matches on thread_id + recipient overlap with high confidence', () => {
    const match = matchDraftToSent(baseSent, [baseSnap]);
    expect(match).not.toBeNull();
    expect(match!.draftId).toBe('draft-1');
    expect(match!.confidence).toBe('high');
  });

  it('skips already-matched draft ids (idempotent evidence)', () => {
    const match = matchDraftToSent(baseSent, [baseSnap], new Set(['draft-1']));
    expect(match).toBeNull();
  });

  it('falls back to recipient + subject when thread differs', () => {
    const match = matchDraftToSent(
      { ...baseSent, threadId: 'other-thread' },
      [{ ...baseSnap, threadId: 'draft-thread' }],
    );
    expect(match).not.toBeNull();
    expect(match!.confidence).toBe('medium');
  });
});

describe('matchTasksToSent', () => {
  it('high-confidence when recipient appears in task text with token overlap', () => {
    const matches = matchTasksToSent(baseSent, [
      {
        id: 'task-1',
        title: 'Follow up with Alice',
        description: 'Email alice@example.com about the partnership chat',
        tags: [],
        priority: 40,
      },
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.confidence).toBe('high');
    expect(matches[0]!.taskId).toBe('task-1');
  });

  it('returns low-confidence semantic-only matches', () => {
    const matches = matchTasksToSent(
      {
        ...baseSent,
        to: [{ email: 'other@example.com' }],
        subject: 'Partnership next steps',
        snippet: 'Next steps on the partnership proposal timeline',
      },
      [
        {
          id: 'task-2',
          title: 'Partnership proposal timeline',
          description: 'Decide next steps on the partnership proposal',
          tags: [],
          priority: 50,
        },
      ],
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]!.confidence).toBe('low');
  });

  it('skips tasks already asked', () => {
    const matches = matchTasksToSent(
      baseSent,
      [
        {
          id: 'task-1',
          title: 'Follow up with Alice',
          description: 'Email alice@example.com',
          tags: [],
          priority: 40,
        },
      ],
      new Set(['task-1']),
    );
    expect(matches).toHaveLength(0);
  });
});

describe('formatDiffBlock', () => {
  it('includes draft and sent sections', () => {
    const match = matchDraftToSent(baseSent, [baseSnap])!;
    const block = formatDiffBlock(match, 'Sent body text');
    expect(block).toContain('draft draft-1');
    expect(block).toContain('### Draft');
    expect(block).toContain('### Sent');
    expect(block).toContain('Sent body text');
  });
});
