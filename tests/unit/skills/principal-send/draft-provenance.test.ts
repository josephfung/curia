import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { DraftProvenance, CURIA_DRAFT_TOOLS, CURIA_EDIT_TOOLS, PROVENANCE_LOOKBACK_DAYS } from '../../../../src/skills/principal-send/draft-provenance.js';
import type { AuditLogRow } from '../../../../src/audit/audit-log-repo.js';

const logger = pino({ level: 'silent' });
const NOW = new Date('2026-11-07T12:00:00.000Z');

function row(toolName: string, result: unknown, at = '2026-11-06T12:00:00.000Z'): AuditLogRow {
  return {
    id: `row-${Math.random()}`,
    timestamp: new Date(at),
    eventType: 'tool.result',
    sourceLayer: 'execution',
    sourceId: 'ceo-inbox',
    conversationId: null,
    taskId: null,
    parentEventId: null,
    payload: { toolName, result },
    action: null, outcome: null, targetType: 'skill', targetId: toolName,
    initiatorType: null, initiatorId: null, entryHash: null,
  } as AuditLogRow;
}

const d = (draftId: string, mailbox = 'default') => ({ mailbox, draftId });

function makeRepo(rows: AuditLogRow[]) {
  return {
    findToolResults: vi.fn().mockResolvedValue(rows),
    findToolResultsForTasks: vi.fn().mockResolvedValue([]),
  };
}

describe('DraftProvenance.createdByCuria', () => {
  it('counts a draft-reply result that created the draft', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', already_exists: false } })]);
    const p = new DraftProvenance(repo, logger, () => NOW);
    expect(await p.createdByCuria([d('d1'), d('d2')])).toEqual(new Set(['default:d1']));
    expect(repo.findToolResults).toHaveBeenCalledWith(expect.objectContaining({
      since: new Date(NOW.getTime() - PROVENANCE_LOOKBACK_DAYS * 86_400_000),
      until: expect.any(Date),
      toolNames: [...CURIA_DRAFT_TOOLS],
    }));
  });

  it('ignores a draft-reply that returned an existing draft', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', already_exists: true } })]);
    expect(await new DraftProvenance(repo, logger, () => NOW).createdByCuria([d('d1')])).toEqual(new Set());
  });

  it('ignores a failed result', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-reply', { success: false, error: 'nope', data: { draft_id: 'd1' } })]);
    expect(await new DraftProvenance(repo, logger, () => NOW).createdByCuria([d('d1')])).toEqual(new Set());
  });

  it('ignores draft-edit results', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'd1' } })]);
    expect(await new DraftProvenance(repo, logger, () => NOW).createdByCuria([d('d1')])).toEqual(new Set());
  });

  it('counts draft-compose, which has no already_exists field', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-compose', { success: true, data: { draft_id: 'd9' } })]);
    expect(await new DraftProvenance(repo, logger, () => NOW).createdByCuria([d('d9')])).toEqual(new Set(['default:d9']));
  });

  it('pages past a full result set', async () => {
    const first = Array.from({ length: 500 }, (_, i) => row('ceo-inbox-draft-compose', { success: true, data: { draft_id: `x${i}` } }, new Date(Date.parse('2026-11-01T00:00:00.000Z') + i * 1000).toISOString()));
    const second = [row('ceo-inbox-draft-compose', { success: true, data: { draft_id: 'late' } }, '2026-11-06T00:00:00.000Z')];
    const repo = makeRepo([]);
    repo.findToolResults.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    expect(await new DraftProvenance(repo, logger, () => NOW).createdByCuria([d('late')])).toEqual(new Set(['default:late']));
    expect(repo.findToolResults).toHaveBeenCalledTimes(2);
  });

  it('throws rather than answer from a read it could not finish', async () => {
    // A full page at one instant cannot be paged past by time.
    const stuck = Array.from({ length: 500 }, () => row('ceo-inbox-draft-compose', { success: true, data: { draft_id: 'other' } }, '2026-10-08T12:00:00.000Z'));
    const repo = makeRepo([]);
    repo.findToolResults.mockResolvedValue(stuck);
    await expect(new DraftProvenance(repo, logger, () => NOW).createdByCuria([d('d1')])).rejects.toThrow('truncated');
  });

  it('throws when the audit read fails', async () => {
    const repo = makeRepo([]);
    repo.findToolResults.mockRejectedValue(new Error('db down'));
    await expect(new DraftProvenance(repo, logger, () => NOW).createdByCuria([d('d1')])).rejects.toThrow('db down');
  });

  it('reads nothing for no draft ids', async () => {
    const repo = makeRepo([]);
    expect(await new DraftProvenance(repo, logger, () => NOW).createdByCuria([])).toEqual(new Set());
    expect(repo.findToolResults).not.toHaveBeenCalled();
  });
});

describe('DraftProvenance.editedByCuria (#2474 final review S1)', () => {
  it('counts a successful draft-edit result for the draft', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'd1' } })]);
    expect(await new DraftProvenance(repo, logger, () => NOW).editedByCuria([d('d1'), d('d2')])).toEqual(new Set(['default:d1']));
    expect(repo.findToolResults).toHaveBeenCalledWith(expect.objectContaining({
      since: new Date(NOW.getTime() - PROVENANCE_LOOKBACK_DAYS * 86_400_000),
      toolNames: [...CURIA_EDIT_TOOLS],
    }));
  });

  it('ignores a failed edit', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-edit', { success: false, error: 'nope', data: { draft_id: 'd1' } })]);
    expect(await new DraftProvenance(repo, logger, () => NOW).editedByCuria([d('d1')])).toEqual(new Set());
  });

  it('does not count a create as an edit, and createdByCuria still ignores edits', async () => {
    const repo = makeRepo([
      row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1' } }),
      row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'd2' } }),
    ]);
    const p = new DraftProvenance(repo, logger, () => NOW);
    expect(await p.editedByCuria([d('d1'), d('d2')])).toEqual(new Set(['default:d2']));
    expect(await p.createdByCuria([d('d1'), d('d2')])).toEqual(new Set(['default:d1']));
  });

  it('throws when the audit read fails', async () => {
    const repo = makeRepo([]);
    repo.findToolResults.mockRejectedValue(new Error('db down'));
    await expect(new DraftProvenance(repo, logger, () => NOW).editedByCuria([d('d1')])).rejects.toThrow('db down');
  });
});

describe('DraftProvenance.curiaWritesInTask (#2474 PR 2)', () => {
  function taskRepo(rows: AuditLogRow[]) {
    const repo = makeRepo([]);
    repo.findToolResultsForTasks.mockResolvedValue(rows);
    return repo;
  }

  it('created only for draft-reply with already_exists false in this task', async () => {
    const created = taskRepo([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', already_exists: false } }, '2026-11-07T11:00:00.000Z')]);
    const p = new DraftProvenance(created, logger, () => NOW);
    expect(await p.curiaWritesInTask(d('d1'), 'task-1')).toEqual({ created: true, lastWriteAt: new Date('2026-11-07T11:00:00.000Z'), replyToMessageId: null });
    expect(created.findToolResultsForTasks).toHaveBeenCalledWith(['task-1'], 500);

    const existing = taskRepo([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', already_exists: true } })]);
    expect(await new DraftProvenance(existing, logger, () => NOW).curiaWritesInTask(d('d1'), 'task-1')).toEqual({ created: false, lastWriteAt: null, replyToMessageId: null });

    const failed = taskRepo([row('ceo-inbox-draft-reply', { success: false, error: 'x', data: { draft_id: 'd1' } })]);
    expect(await new DraftProvenance(failed, logger, () => NOW).curiaWritesInTask(d('d1'), 'task-1')).toEqual({ created: false, lastWriteAt: null, replyToMessageId: null });

    const other = taskRepo([row('ceo-inbox-draft-compose', { success: true, data: { draft_id: 'd2' } })]);
    expect(await new DraftProvenance(other, logger, () => NOW).curiaWritesInTask(d('d1'), 'task-1')).toEqual({ created: false, lastWriteAt: null, replyToMessageId: null });
  });

  it('lastWriteAt includes a same-task draft-edit', async () => {
    // Newest first, as findToolResultsForTasks returns them.
    const repo = taskRepo([
      row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'd1' } }, '2026-11-07T11:30:00.000Z'),
      row('ceo-inbox-draft-edit', { success: false, error: 'x', data: { draft_id: 'd1' } }, '2026-11-07T11:45:00.000Z'),
      row('ceo-inbox-draft-compose', { success: true, data: { draft_id: 'd1' } }, '2026-11-07T11:00:00.000Z'),
    ]);
    expect(await new DraftProvenance(repo, logger, () => NOW).curiaWritesInTask(d('d1'), 'task-1'))
      .toEqual({ created: true, lastWriteAt: new Date('2026-11-07T11:30:00.000Z'), replyToMessageId: null });
  });

  it('a draft created in another task is not created', async () => {
    // The lookback finds it, but this task's results do not.
    const repo = taskRepo([row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'd1' } }, '2026-11-07T11:30:00.000Z')]);
    repo.findToolResults.mockResolvedValue([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', already_exists: false } })]);
    const result = await new DraftProvenance(repo, logger, () => NOW).curiaWritesInTask(d('d1'), 'task-2');
    expect(result.created).toBe(false);
    expect(repo.findToolResults).not.toHaveBeenCalled();
  });

  // Final fixes A5 (security review M2): the message the creating draft-reply answered.
  it('returns the reply_to_message_id of the draft-reply that created the draft', async () => {
    const repo = taskRepo([
      row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'd1', reply_to_message_id: 'forged' } }, '2026-11-07T11:30:00.000Z'),
      row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', already_exists: false, reply_to_message_id: 'm-latest' } }, '2026-11-07T11:00:00.000Z'),
    ]);
    expect(await new DraftProvenance(repo, logger, () => NOW).curiaWritesInTask(d('d1'), 'task-1'))
      .toEqual({ created: true, lastWriteAt: new Date('2026-11-07T11:30:00.000Z'), replyToMessageId: 'm-latest' });
    // Never from a result that did not create the draft.
    const existing = taskRepo([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', already_exists: true, reply_to_message_id: 'm-old' } })]);
    expect((await new DraftProvenance(existing, logger, () => NOW).curiaWritesInTask(d('d1'), 'task-1')).replyToMessageId).toBeNull();
  });

  it('throws when the audit read fails', async () => {
    const repo = makeRepo([]);
    repo.findToolResultsForTasks.mockRejectedValue(new Error('db down'));
    await expect(new DraftProvenance(repo, logger, () => NOW).curiaWritesInTask(d('d1'), 'task-1')).rejects.toThrow('db down');
  });
});

// Draft provenance is keyed by (mailbox, draft id) (#2475, Task 16).
describe('DraftProvenance by mailbox (#2475)', () => {
  /** A repo that honours toolNames, as the real one does. */
  function filteringRepo(rows: AuditLogRow[]) {
    return {
      findToolResults: vi.fn(async (opts: { toolNames?: string[] }) =>
        rows.filter((r) => opts.toolNames?.includes(r.payload['toolName'] as string) ?? true)),
      findToolResultsForTasks: vi.fn().mockResolvedValue(rows),
    };
  }

  it('matches on mailbox and draft id', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', mailbox: 'work' } })]);
    const p = new DraftProvenance(repo, logger, () => NOW);
    expect(await p.createdByCuria([d('d1', 'work'), d('d1', 'personal')])).toEqual(new Set(['work:d1']));
  });

  it('legacy rows without mailbox match the default mailbox', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1' } })]);
    const p = new DraftProvenance(repo, logger, () => NOW, async () => 'work');
    expect(await p.createdByCuria([d('d1', 'work'), d('d1', 'personal')])).toEqual(new Set(['work:d1']));
  });

  it('a moved draft keeps its authorship class', async () => {
    const rows = [
      row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'src', mailbox: 'work' } }),
      row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'new', mailbox: 'personal', moved_from: { mailbox: 'work', draft_id: 'src' } } }),
      // A principal-written draft moved: not Curia-created, but edited by Curia.
      row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'new2', mailbox: 'personal', moved_from: { mailbox: 'work', draft_id: 'own' } } }),
    ];
    const p = new DraftProvenance(filteringRepo(rows), logger, () => NOW);
    const wanted = [d('new', 'personal'), d('new2', 'personal')];
    expect(await p.createdByCuria(wanted)).toEqual(new Set(['personal:new']));
    expect(await p.editedByCuria(wanted)).toEqual(new Set(['personal:new', 'personal:new2']));
  });

  it('a moved draft whose source is unknown is Curia\'s', async () => {
    const rows = [row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'new', mailbox: 'personal', moved_from: 'garbled' } })];
    const p = new DraftProvenance(filteringRepo(rows), logger, () => NOW);
    expect(await p.createdByCuria([d('new', 'personal')])).toEqual(new Set(['personal:new']));
  });

  it('follows a chain of moves back to the original', async () => {
    const rows = [
      row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'a', mailbox: 'work' } }),
      row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'b', mailbox: 'personal', moved_from: { mailbox: 'work', draft_id: 'a' } } }),
      row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'c', mailbox: 'work', moved_from: { mailbox: 'personal', draft_id: 'b' } } }),
    ];
    const p = new DraftProvenance(filteringRepo(rows), logger, () => NOW);
    expect(await p.createdByCuria([d('c', 'work')])).toEqual(new Set(['work:c']));
  });

  it('curiaWritesInTask matches the draft in its mailbox only', async () => {
    const repo = {
      findToolResults: vi.fn(),
      findToolResultsForTasks: vi.fn().mockResolvedValue([
        row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', mailbox: 'work', reply_to_message_id: 'm1' } }),
      ]),
    };
    const p = new DraftProvenance(repo, logger, () => NOW);
    expect((await p.curiaWritesInTask(d('d1', 'work'), 't')).created).toBe(true);
    expect((await p.curiaWritesInTask(d('d1', 'personal'), 't')).created).toBe(false);
  });
});

// R40: review strictness never lightens on a mailbox mismatch (#2475).
describe('DraftProvenance review lookups across a default change (R40)', () => {
  const live = async () => ['work', 'personal'];
  const mk = (repo: ReturnType<typeof makeRepo>) => new DraftProvenance(repo, logger, () => NOW, async () => 'personal', live);

  it('a legacy row with no mailbox still reads as Curia\'s after the default changed', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1' } })]);
    expect(await mk(repo).createdByCuria([d('d1', 'work')])).toEqual(new Set(['work:d1']));
  });

  it('an edit row from the migration fallback mailbox id still reads as Curia\'s', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'd1', mailbox: 'mailbox' } })]);
    expect(await mk(repo).editedByCuria([d('d1', 'work')])).toEqual(new Set(['work:d1']));
  });

  it('a row with a live but different mailbox does not match', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', mailbox: 'personal' } })]);
    expect(await mk(repo).createdByCuria([d('d1', 'work')])).toEqual(new Set());
  });

  it('curiaWritesInTask stays exact', async () => {
    const repo = {
      findToolResults: vi.fn(),
      findToolResultsForTasks: vi.fn().mockResolvedValue([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1' } })]),
    };
    const p = new DraftProvenance(repo, logger, () => NOW, async () => 'personal', live);
    expect((await p.curiaWritesInTask(d('d1', 'work'), 't')).created).toBe(false);
  });

  it('any unreadable move source makes the moved draft Curia\'s', async () => {
    const rows = [
      row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'a', mailbox: 'work' } }),
      row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'n', mailbox: 'personal', moved_from: { mailbox: 'work', draft_id: 'zz' } } }),
      row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'n', mailbox: 'personal', moved_from: 'garbled' } }),
    ];
    const repo = {
      findToolResults: vi.fn(async (o: { toolNames?: string[] }) => rows.filter((r) => o.toolNames?.includes(r.payload['toolName'] as string))),
      findToolResultsForTasks: vi.fn(),
    };
    expect(await new DraftProvenance(repo, logger, () => NOW).createdByCuria([d('n', 'personal')])).toEqual(new Set(['personal:n']));
  });
});
