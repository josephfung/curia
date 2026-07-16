import { describe, it, expect } from 'vitest';
import {
  matchDraftToSent,
  matchTasksToSent,
  formatDiffBlock,
  formatCompletionCandidateBlock,
  trimEvidenceDoc,
  type DraftSnapshotLike,
  type SentMessageLike,
  type TaskMatch,
} from './sent-observe-match.js';
import { parsePendingDiffs } from './voice-learn-logic.js';
import { parseCompletionCandidates } from './task-completion-risk.js';

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

  it('does not grant high confidence when the local-part is only a substring', () => {
    // recipient ann@example.com must NOT match the word "annual" in the task text.
    const matches = matchTasksToSent(
      {
        ...baseSent,
        to: [{ email: 'ann@example.com' }],
        subject: 'Weekly note',
        snippet: 'A quick weekly note about nothing in particular',
      },
      [
        {
          id: 'task-annual',
          title: 'Annual planning offsite',
          description: 'Organise the annual planning offsite agenda',
          tags: [],
          priority: 40,
        },
      ],
    );
    // Either no match, or at most a low-confidence semantic one — never high via substring.
    expect(matches.every((m) => m.confidence !== 'high')).toBe(true);
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

describe('trimEvidenceDoc', () => {
  const DRAFT_BODY = 'Thanks Alice, following up on the partnership timeline. Can we meet Tuesday?';
  const SENT_BODY = 'Thanks Alice, following up on the partnership timeline. Could we meet Wednesday instead?';

  // Build a diff block whose sent_at is derived from `date` (unix seconds).
  function diffBlock(date: number): string {
    const sent: SentMessageLike = { ...baseSent, id: `msg-${date}`, date };
    const snap: DraftSnapshotLike = {
      ...baseSnap,
      draftId: `draft-${date}`,
      body: DRAFT_BODY,
      // Draft must not post-date the send, or matchDraftToSent skips it.
      createdAt: new Date((date - 1000) * 1000).toISOString(),
    };
    const match = matchDraftToSent(sent, [snap])!;
    return formatDiffBlock(match, SENT_BODY);
  }

  function completionBlock(date: number, taskId: string): string {
    const match: TaskMatch = {
      messageId: `msg-${date}`,
      taskId,
      confidence: 'high',
      reason: 'recipient+semantic',
      sentSubject: 'Follow up',
      sentRecipients: ['alice@example.com'],
      sentAt: new Date(date * 1000).toISOString(),
      taskTitle: 'Follow up with Alice',
    };
    return formatCompletionCandidateBlock(match);
  }

  const OLD = 1_600_000_000; // 2020-09-13
  const NEW = 1_720_000_000; // 2024-07-03
  const CUTOFF = new Date(1_700_000_000_000).toISOString(); // 2023-11-14, between OLD and NEW

  it('drops a diff block older than the cutoff and keeps a newer one (re-parses to the kept pair)', () => {
    const body = `# Pending voice diffs\n${diffBlock(OLD)}${diffBlock(NEW)}`;
    const trimmed = trimEvidenceDoc(body, CUTOFF);

    // Preamble preserved; old block gone; new block intact.
    expect(trimmed).toContain('# Pending voice diffs');
    expect(trimmed).not.toContain(`draft draft-${OLD}`);
    expect(trimmed).toContain(`draft draft-${NEW}`);

    const pairs = parsePendingDiffs(trimmed);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.draftId).toBe(`draft-${NEW}`);
    expect(pairs[0]!.messageId).toBe(`msg-${NEW}`);
  });

  it('drops an old block whose body contains a "## " line without leaving a tail (splits on real headers only)', () => {
    // A sent email body can legitimately contain a markdown H2 that survives htmlToPlainText.
    // The block boundary must be the real Diff/Candidate header, not any `## ` line — otherwise
    // the old block's tail (which has no `sent_at`) is wrongly retained, partially defeating the
    // retention bound for exactly the sensitive bodies F3 is meant to age out.
    const sentWithHeading = `Here's the plan.\n\n## Agenda\n\n- item one\n- item two`;
    const sent: SentMessageLike = { ...baseSent, id: `msg-${OLD}`, date: OLD };
    const snap: DraftSnapshotLike = {
      ...baseSnap,
      draftId: `draft-${OLD}`,
      body: DRAFT_BODY,
      createdAt: new Date((OLD - 1000) * 1000).toISOString(),
    };
    const oldBlock = formatDiffBlock(matchDraftToSent(sent, [snap])!, sentWithHeading);
    const trimmed = trimEvidenceDoc(`# Pending voice diffs\n${oldBlock}${diffBlock(NEW)}`, CUTOFF);

    // The entire old block is gone — header, metadata, body heading, and tail.
    expect(trimmed).not.toContain(`draft draft-${OLD}`);
    expect(trimmed).not.toContain('## Agenda');
    expect(trimmed).not.toContain('item two');
    // The newer block survives and still round-trips to exactly the kept pair.
    const pairs = parsePendingDiffs(trimmed);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.draftId).toBe(`draft-${NEW}`);
  });

  it('keeps a block whose sent_at is missing or unparseable (never drops on parse failure)', () => {
    const garbage = `\n## Diff — draft dg ↔ sent mg\n\n- thread_id: t\n- confidence: high\n- sent_at: not-a-date\n- subject: x\n- recipients: a@b.com\n\n### Draft\n\n${DRAFT_BODY}\n\n### Sent\n\n${SENT_BODY}\n\n---\n`;
    const missing = `\n## Diff — draft dm ↔ sent mm\n\n- thread_id: t\n- confidence: high\n- subject: x\n- recipients: a@b.com\n\n### Draft\n\n${DRAFT_BODY}\n\n### Sent\n\n${SENT_BODY}\n\n---\n`;
    // Cutoff in the far future — anything with a valid, older sent_at would be dropped.
    const cutoff = new Date(4_000_000_000_000).toISOString();
    const trimmed = trimEvidenceDoc(`# H\n${garbage}${missing}`, cutoff);
    expect(trimmed).toContain('draft dg');
    expect(trimmed).toContain('draft dm');
  });

  it('trims completion blocks too (re-parses via parseCompletionCandidates)', () => {
    const body = `# Pending task-completion candidates\n${completionBlock(OLD, 'task-old')}${completionBlock(NEW, 'task-new')}`;
    const trimmed = trimEvidenceDoc(body, CUTOFF);

    const candidates = parseCompletionCandidates(trimmed);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.taskId).toBe('task-new');
  });

  it('returns an empty / block-free body unchanged', () => {
    expect(trimEvidenceDoc('', CUTOFF)).toBe('');
    expect(trimEvidenceDoc('# Just a header\n\nno blocks here\n', CUTOFF)).toBe(
      '# Just a header\n\nno blocks here\n',
    );
  });

  it('returns the body unchanged when the cutoff itself is unparseable', () => {
    const body = `# H\n${diffBlock(OLD)}`;
    expect(trimEvidenceDoc(body, 'not-a-date')).toBe(body);
  });
});
