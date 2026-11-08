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
    expect(await p.createdByCuria(['d1', 'd2'])).toEqual(new Set(['d1']));
    expect(repo.findToolResults).toHaveBeenCalledWith(expect.objectContaining({
      since: new Date(NOW.getTime() - PROVENANCE_LOOKBACK_DAYS * 86_400_000),
      until: expect.any(Date),
      toolNames: [...CURIA_DRAFT_TOOLS],
    }));
  });

  it('ignores a draft-reply that returned an existing draft', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', already_exists: true } })]);
    expect(await new DraftProvenance(repo, logger, () => NOW).createdByCuria(['d1'])).toEqual(new Set());
  });

  it('ignores a failed result', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-reply', { success: false, error: 'nope', data: { draft_id: 'd1' } })]);
    expect(await new DraftProvenance(repo, logger, () => NOW).createdByCuria(['d1'])).toEqual(new Set());
  });

  it('ignores draft-edit results', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'd1' } })]);
    expect(await new DraftProvenance(repo, logger, () => NOW).createdByCuria(['d1'])).toEqual(new Set());
  });

  it('counts draft-compose, which has no already_exists field', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-compose', { success: true, data: { draft_id: 'd9' } })]);
    expect(await new DraftProvenance(repo, logger, () => NOW).createdByCuria(['d9'])).toEqual(new Set(['d9']));
  });

  it('pages past a full result set', async () => {
    const first = Array.from({ length: 500 }, (_, i) => row('ceo-inbox-draft-compose', { success: true, data: { draft_id: `x${i}` } }, new Date(Date.parse('2026-11-01T00:00:00.000Z') + i * 1000).toISOString()));
    const second = [row('ceo-inbox-draft-compose', { success: true, data: { draft_id: 'late' } }, '2026-11-06T00:00:00.000Z')];
    const repo = makeRepo([]);
    repo.findToolResults.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    expect(await new DraftProvenance(repo, logger, () => NOW).createdByCuria(['late'])).toEqual(new Set(['late']));
    expect(repo.findToolResults).toHaveBeenCalledTimes(2);
  });

  it('throws rather than answer from a read it could not finish', async () => {
    // A full page at one instant cannot be paged past by time.
    const stuck = Array.from({ length: 500 }, () => row('ceo-inbox-draft-compose', { success: true, data: { draft_id: 'other' } }, '2026-10-08T12:00:00.000Z'));
    const repo = makeRepo([]);
    repo.findToolResults.mockResolvedValue(stuck);
    await expect(new DraftProvenance(repo, logger, () => NOW).createdByCuria(['d1'])).rejects.toThrow('truncated');
  });

  it('throws when the audit read fails', async () => {
    const repo = makeRepo([]);
    repo.findToolResults.mockRejectedValue(new Error('db down'));
    await expect(new DraftProvenance(repo, logger, () => NOW).createdByCuria(['d1'])).rejects.toThrow('db down');
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
    expect(await new DraftProvenance(repo, logger, () => NOW).editedByCuria(['d1', 'd2'])).toEqual(new Set(['d1']));
    expect(repo.findToolResults).toHaveBeenCalledWith(expect.objectContaining({
      since: new Date(NOW.getTime() - PROVENANCE_LOOKBACK_DAYS * 86_400_000),
      toolNames: [...CURIA_EDIT_TOOLS],
    }));
  });

  it('ignores a failed edit', async () => {
    const repo = makeRepo([row('ceo-inbox-draft-edit', { success: false, error: 'nope', data: { draft_id: 'd1' } })]);
    expect(await new DraftProvenance(repo, logger, () => NOW).editedByCuria(['d1'])).toEqual(new Set());
  });

  it('does not count a create as an edit, and createdByCuria still ignores edits', async () => {
    const repo = makeRepo([
      row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1' } }),
      row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'd2' } }),
    ]);
    const p = new DraftProvenance(repo, logger, () => NOW);
    expect(await p.editedByCuria(['d1', 'd2'])).toEqual(new Set(['d2']));
    expect(await p.createdByCuria(['d1', 'd2'])).toEqual(new Set(['d1']));
  });

  it('throws when the audit read fails', async () => {
    const repo = makeRepo([]);
    repo.findToolResults.mockRejectedValue(new Error('db down'));
    await expect(new DraftProvenance(repo, logger, () => NOW).editedByCuria(['d1'])).rejects.toThrow('db down');
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
    expect(await p.curiaWritesInTask('d1', 'task-1')).toEqual({ created: true, lastWriteAt: new Date('2026-11-07T11:00:00.000Z'), replyToMessageId: null });
    expect(created.findToolResultsForTasks).toHaveBeenCalledWith(['task-1'], 500);

    const existing = taskRepo([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', already_exists: true } })]);
    expect(await new DraftProvenance(existing, logger, () => NOW).curiaWritesInTask('d1', 'task-1')).toEqual({ created: false, lastWriteAt: null, replyToMessageId: null });

    const failed = taskRepo([row('ceo-inbox-draft-reply', { success: false, error: 'x', data: { draft_id: 'd1' } })]);
    expect(await new DraftProvenance(failed, logger, () => NOW).curiaWritesInTask('d1', 'task-1')).toEqual({ created: false, lastWriteAt: null, replyToMessageId: null });

    const other = taskRepo([row('ceo-inbox-draft-compose', { success: true, data: { draft_id: 'd2' } })]);
    expect(await new DraftProvenance(other, logger, () => NOW).curiaWritesInTask('d1', 'task-1')).toEqual({ created: false, lastWriteAt: null, replyToMessageId: null });
  });

  it('lastWriteAt includes a same-task draft-edit', async () => {
    // Newest first, as findToolResultsForTasks returns them.
    const repo = taskRepo([
      row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'd1' } }, '2026-11-07T11:30:00.000Z'),
      row('ceo-inbox-draft-edit', { success: false, error: 'x', data: { draft_id: 'd1' } }, '2026-11-07T11:45:00.000Z'),
      row('ceo-inbox-draft-compose', { success: true, data: { draft_id: 'd1' } }, '2026-11-07T11:00:00.000Z'),
    ]);
    expect(await new DraftProvenance(repo, logger, () => NOW).curiaWritesInTask('d1', 'task-1'))
      .toEqual({ created: true, lastWriteAt: new Date('2026-11-07T11:30:00.000Z'), replyToMessageId: null });
  });

  it('a draft created in another task is not created', async () => {
    // The lookback finds it, but this task's results do not.
    const repo = taskRepo([row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'd1' } }, '2026-11-07T11:30:00.000Z')]);
    repo.findToolResults.mockResolvedValue([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', already_exists: false } })]);
    const result = await new DraftProvenance(repo, logger, () => NOW).curiaWritesInTask('d1', 'task-2');
    expect(result.created).toBe(false);
    expect(repo.findToolResults).not.toHaveBeenCalled();
  });

  // Final fixes A5 (security review M2): the message the creating draft-reply answered.
  it('returns the reply_to_message_id of the draft-reply that created the draft', async () => {
    const repo = taskRepo([
      row('ceo-inbox-draft-edit', { success: true, data: { draft_id: 'd1', reply_to_message_id: 'forged' } }, '2026-11-07T11:30:00.000Z'),
      row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', already_exists: false, reply_to_message_id: 'm-latest' } }, '2026-11-07T11:00:00.000Z'),
    ]);
    expect(await new DraftProvenance(repo, logger, () => NOW).curiaWritesInTask('d1', 'task-1'))
      .toEqual({ created: true, lastWriteAt: new Date('2026-11-07T11:30:00.000Z'), replyToMessageId: 'm-latest' });
    // Never from a result that did not create the draft.
    const existing = taskRepo([row('ceo-inbox-draft-reply', { success: true, data: { draft_id: 'd1', already_exists: true, reply_to_message_id: 'm-old' } })]);
    expect((await new DraftProvenance(existing, logger, () => NOW).curiaWritesInTask('d1', 'task-1')).replyToMessageId).toBeNull();
  });

  it('throws when the audit read fails', async () => {
    const repo = makeRepo([]);
    repo.findToolResultsForTasks.mockRejectedValue(new Error('db down'));
    await expect(new DraftProvenance(repo, logger, () => NOW).curiaWritesInTask('d1', 'task-1')).rejects.toThrow('db down');
  });
});
