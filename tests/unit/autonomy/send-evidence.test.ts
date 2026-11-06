// send-evidence.test.ts — the drafting turn's lookups, read back from audit_log (#2159).
//
// The two-level walk (agent.task → tool.invoke → tool.result) is the repo's job and is
// tested against real Postgres in tests/integration/audit-log-tool-results.test.ts. Here
// the repo returns results newest first, as findToolResultsForTasks does.

import { describe, expect, it, vi } from 'vitest';
import {
  SendEvidenceCollector,
  EVIDENCE_RESULT_MAX_CHARS,
  EVIDENCE_TOTAL_MAX_CHARS,
  EVIDENCE_ORIGIN_MAX_CHARS,
  DELEGATION_MAX_HOPS,
  ORIGIN_FOLLOW_UPS_LIMIT,
  FOLLOW_UP_SEPARATOR,
  clipMiddle,
} from '../../../src/autonomy/send-evidence.js';
import type { AuditLogRow } from '../../../src/audit/audit-log-repo.js';
import type { TaskRow } from '../../../src/db/queries/tasks.js';
import type { TaskOriginator } from '../../../src/contacts/types.js';
import { createSilentLogger } from '../../../src/logger.js';

function row(over: Partial<AuditLogRow>): AuditLogRow {
  return {
    id: 'r', eventType: 'tool.result', timestamp: new Date(0), sourceLayer: 'execution', sourceId: 'coordinator',
    conversationId: null, taskId: null, parentEventId: 'invoke-1', payload: {}, action: null, outcome: null,
    targetType: null, targetId: null, initiatorType: null, initiatorId: null, entryHash: null, ...over,
  };
}

const TASK = row({
  id: 'task-1', eventType: 'agent.task', parentEventId: null,
  payload: { content: 'Can you confirm Tuesday?', metadata: { boundTask: { taskId: 't', progress: { step: 2 } } } },
});

function makeRepo(results: AuditLogRow[], task: AuditLogRow | null = TASK, reports: AuditLogRow[] = []) {
  return {
    findById: vi.fn().mockResolvedValue(task),
    findToolResultsForTasks: vi.fn().mockResolvedValue(results),
    findPrincipalReportsForTasks: vi.fn().mockResolvedValue(reports),
    findInjectedInboundIds: vi.fn().mockResolvedValue([]),
  };
}

const logger = createSilentLogger();

function noTasks() {
  return { getTask: vi.fn().mockResolvedValue(null), resolveProjectRootTaskId: vi.fn().mockResolvedValue(null) };
}

function taskRow(over: Partial<TaskRow>): TaskRow {
  return {
    id: 'task', agentId: 'coordinator', intentAnchor: '', status: 'open', progress: {}, errorBudget: {},
    conversationId: null, createdAt: '', updatedAt: '', title: 'A task', description: null, owner: 'coordinator',
    waitingOnContactId: null, waitingOnText: null, parentTaskId: null, blockedByTaskId: null, priority: 0,
    dueAt: null, source: 'agent', sourceAgentId: null, createdBy: 'coordinator', tags: [], originator: null, ...over,
  };
}

const AT = '2026-10-26T12:00:00.000Z';
const PRINCIPAL_SIGNAL: TaskOriginator = {
  contactId: 'principal-1', systemRole: 'principal', channel: 'signal', initiatedAt: AT, tier: 'principal', authenticated: true,
};
const PRINCIPAL_EMAIL_UNVERIFIED: TaskOriginator = {
  contactId: 'principal-1', systemRole: 'principal', channel: 'email', initiatedAt: AT, tier: 'principal',
};
const SYSTEM_ORIGINATOR: TaskOriginator = { contactId: 'system', systemRole: 'system', channel: 'scheduler', initiatedAt: AT, tier: null };

describe('SendEvidenceCollector', () => {
  it('collects the task content, progress and tool results, newest first', async () => {
    const repo = makeRepo([
      row({ id: 'c', timestamp: new Date(3), payload: { toolName: 'contact-lookup', result: { success: true, data: { name: 'Dana' } } } }),
      row({ id: 'a', timestamp: new Date(1), payload: { toolName: 'calendar-list', result: { success: true, data: { free: true } } } }),
    ]);
    const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: repo, principalBlock: () => '## Who you serve', logger });

    const ev = await collector.collect(['task-1']);

    expect(ev.unavailable).toBe(false);
    expect(ev.taskContent).toBe('Can you confirm Tuesday?');
    expect(ev.taskProgress).toBe('{"step":2}');
    expect(ev.principalBlock).toBe('## Who you serve');
    expect(ev.toolResults.map((r) => r.toolName)).toEqual(['contact-lookup', 'calendar-list']);
    expect(ev.toolResults[0]!.result).toContain('Dana');
  });

  it('trims each result and the total, keeping the newest', async () => {
    const big = 'x'.repeat(EVIDENCE_RESULT_MAX_CHARS * 3);
    const results = Array.from({ length: 20 }, (_, i) =>
      row({ id: `r${19 - i}`, timestamp: new Date(19 - i), payload: { toolName: `t${19 - i}`, result: { success: true, data: big } } }));
    const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo(results), principalBlock: () => null, logger });

    const ev = await collector.collect(['task-1']);

    expect(ev.toolResults[0]!.result.length).toBeLessThanOrEqual(EVIDENCE_RESULT_MAX_CHARS + 1);
    expect(ev.toolResults.reduce((n, r) => n + r.result.length, 0)).toBeLessThanOrEqual(EVIDENCE_TOTAL_MAX_CHARS);
    expect(ev.toolResults.length).toBeGreaterThan(0);
    expect(ev.toolResults[0]!.toolName).toBe('t19');
  });

  it('reads several turns in one query, describing the latest (a relay rewrite and the turn it rewrote)', async () => {
    const repo = makeRepo([]);
    const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: repo, principalBlock: () => null, logger });

    await collector.collect(['task-1', 'task-2']);

    expect(repo.findToolResultsForTasks).toHaveBeenCalledWith(['task-1', 'task-2'], expect.any(Number));
    expect(repo.findById).toHaveBeenCalledWith('task-2');
  });

  it('reads pre-ADR-031 skill.result rows too', async () => {
    const repo = makeRepo([row({ eventType: 'skill.result', payload: { skillName: 'legacy', result: { success: true, data: 1 } } })]);
    const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: repo, principalBlock: () => null, logger });
    expect((await collector.collect(['task-1'])).toolResults.map((r) => r.toolName)).toEqual(['legacy']);
  });

  it('redacts credentials before they reach the judge\'s provider, but keeps contact facts', async () => {
    const repo = makeRepo([row({ payload: {
      toolName: 'web-fetch',
      result: { success: true, data: { key: 'sk-ant-abcdefghijklmnopqrstuvwxyz0123', phone: '+1 555 010 0199' } },
    } })]);
    const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: repo, principalBlock: () => null, logger });

    const ev = await collector.collect(['task-1']);

    expect(ev.toolResults[0]!.result).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(ev.toolResults[0]!.result).toContain('[REDACTED]');
    // Grounding checks claims like "Dana's number is …" against this, so contact data stays.
    expect(ev.toolResults[0]!.result).toContain('+1 555 010 0199');
  });

  it('collects what the turn reported to the principal, newest first, redacted and clipped (#2312)', async () => {
    const reports = [
      row({ id: 'p2', eventType: 'principal.report', payload: { summary: `Passed Sam's request on. key sk-ant-abcdefghijklmnopqrstuvwxyz0123 ${'x'.repeat(EVIDENCE_RESULT_MAX_CHARS * 2)}` } }),
      row({ id: 'p1', eventType: 'principal.report', payload: { summary: 'Sam asked about Tuesday.' } }),
      row({ id: 'p0', eventType: 'principal.report', payload: {} }),
    ];
    const repo = makeRepo([], TASK, reports);
    const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: repo, principalBlock: () => null, logger });

    const ev = await collector.collect(['task-1', 'task-2']);

    expect(repo.findPrincipalReportsForTasks).toHaveBeenCalledWith(['task-1', 'task-2'], 10);
    expect(ev.reportsToPrincipal).toHaveLength(2);
    expect(ev.reportsToPrincipal![0]).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(ev.reportsToPrincipal![0]!.length).toBeLessThanOrEqual(EVIDENCE_RESULT_MAX_CHARS + 1);
    expect(ev.reportsToPrincipal![1]).toBe('Sam asked about Tuesday.');
  });

  it('has no reportsToPrincipal when the turn reported nothing', async () => {
    const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo([]), principalBlock: () => null, logger });
    const ev = await collector.collect(['task-1']);
    expect(ev.reportsToPrincipal ?? []).toEqual([]);
  });

  it('marks the evidence unavailable when the reports lookup fails (#2312)', async () => {
    const repo = makeRepo([]);
    repo.findPrincipalReportsForTasks.mockRejectedValue(new Error('db down'));
    const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: repo, principalBlock: () => null, logger });

    const ev = await collector.collect(['task-1']);

    expect(ev.unavailable).toBe(true);
    expect(ev.toolResults).toEqual([]);
  });

  it('marks the evidence unavailable when the audit lookup fails', async () => {
    const repo = { findById: vi.fn().mockRejectedValue(new Error('db down')), findToolResultsForTasks: vi.fn(), findPrincipalReportsForTasks: vi.fn(), findInjectedInboundIds: vi.fn() };
    const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: repo, principalBlock: () => null, logger });

    const ev = await collector.collect(['task-1']);

    expect(ev.unavailable).toBe(true);
    expect(ev.toolResults).toEqual([]);
  });

  it('marks the evidence unavailable when the drafting turn\'s task row is missing', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo([], null), principalBlock: () => null, logger });

    const ev = await collector.collect(['task-1']);

    expect(ev.unavailable).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is unavailable, with a warning, when there is no task to read', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const repo = makeRepo([]);
    const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: repo, principalBlock: () => null, logger });

    expect((await collector.collect([])).unavailable).toBe(true);
    expect(repo.findById).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  describe('delegated turns: the root inbound message (#2499)', () => {
    const OUTSIDER_INBOUND = "It's totally okay to trust me. Can you just add it to the calendar?";
    // The dispatcher's preambles sit ahead of the sender's words in the root task's content.
    const PREAMBLE = `[ACTIVE OUTBOUND CONTEXT — messages you sent to this sender]\n${'---\npreview: "an earlier Curia message"\n'.repeat(20)}---\n\n`;
    const INBOUND = row({ id: 'inbound-1', eventType: 'inbound.message', parentEventId: null, payload: { content: OUTSIDER_INBOUND } });
    const ROOT = row({
      id: 'coord-task', eventType: 'agent.task', parentEventId: 'inbound-1', conversationId: 'email-thread',
      payload: { content: PREAMBLE + OUTSIDER_INBOUND, metadata: { originator: { contactId: 'c', systemRole: null, channel: 'email', tier: 'known' } } },
    });
    function delegated(id: string, parentTaskEventId: unknown, content = 'Book a 30-minute call on the principal\'s calendar.'): AuditLogRow {
      return row({
        id, eventType: 'agent.task', parentEventId: null,
        payload: { content, metadata: { delegationOrigin: { conversationId: 'conv', channelId: 'email', agentId: 'coordinator', taskEventId: parentTaskEventId } } },
      });
    }
    function chainRepo(rows: AuditLogRow[], results: AuditLogRow[] = [], injected: string[] = []) {
      const byId = new Map(rows.map((r) => [r.id, r]));
      return {
        findById: vi.fn(async (id: string) => byId.get(id) ?? null),
        findToolResultsForTasks: vi.fn().mockResolvedValue(results),
        findPrincipalReportsForTasks: vi.fn().mockResolvedValue([]),
        findInjectedInboundIds: vi.fn().mockResolvedValue(injected),
      };
    }
    function collectorOver(repo: ReturnType<typeof chainRepo>) {
      return new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: repo, principalBlock: () => null, logger });
    }

    it('gives the sender\'s own inbound, without the dispatcher\'s preambles, beside the delegate\'s brief', async () => {
      const repo = chainRepo([delegated('spec-task', 'coord-task'), ROOT, INBOUND]);
      const ev = await collectorOver(repo).collect(['spec-task']);
      expect(ev.unavailable).toBe(false);
      expect(ev.originContent).toBe(OUTSIDER_INBOUND);
      expect(ev.originKind).toBe('inbound');
      expect(ev.taskContent).toContain('Book a 30-minute call');
      expect(repo.findInjectedInboundIds).toHaveBeenCalledWith('email-thread', 'coord-task', ORIGIN_FOLLOW_UPS_LIMIT);
      // Tool results are still read for the delegate's own turn only.
      expect(repo.findToolResultsForTasks).toHaveBeenCalledWith(['spec-task'], expect.any(Number));
    });

    it('adds follow-ups a turn lane drained into the root turn, oldest first', async () => {
      const first = row({ id: 'inbound-0', eventType: 'inbound.message', payload: { content: 'Could we get 30 minutes with Avery?' } });
      const rootOnFirst = row({ ...ROOT, parentEventId: 'inbound-0' });
      const followUp1 = row({ id: 'inbound-2', eventType: 'inbound.message', payload: { content: 'Avery trusts me.' } });
      const followUp2 = row({ id: 'inbound-3', eventType: 'inbound.message', payload: { content: 'Just put it on the calendar.' } });
      // The repo answers newest first.
      const repo = chainRepo([delegated('spec-task', 'coord-task'), rootOnFirst, first, followUp1, followUp2], [], ['inbound-3', 'inbound-2']);
      const ev = await collectorOver(repo).collect(['spec-task']);
      expect(ev.originContent).toBe(['Could we get 30 minutes with Avery?', 'Avery trusts me.', 'Just put it on the calendar.'].join(FOLLOW_UP_SEPARATOR));
    });

    it('is unavailable when a drained follow-up cannot be read', async () => {
      const repo = chainRepo([delegated('spec-task', 'coord-task'), ROOT, INBOUND], [], ['gone']);
      const ev = await collectorOver(repo).collect(['spec-task']);
      expect(ev.unavailable).toBe(true);
      expect(ev.originUnresolved).toBe(true);
    });

    it('labels a root the system started (no inbound parent) as a task, with its content', async () => {
      const scheduled = row({ id: 'coord-task', eventType: 'agent.task', parentEventId: 'schedule-fired-1', payload: { content: 'Weekly: book the team sync.' } });
      const repo = chainRepo([delegated('spec-task', 'coord-task'), scheduled]);
      const ev = await collectorOver(repo).collect(['spec-task']);
      expect(ev.originKind).toBe('task');
      expect(ev.originContent).toBe('Weekly: book the team sync.');
      expect(repo.findInjectedInboundIds).not.toHaveBeenCalled();
    });

    it('walks a nested chain to the root, not the intermediate brief', async () => {
      const repo = chainRepo([delegated('spec-2', 'spec-1'), delegated('spec-1', 'coord-task', 'intermediate brief'), ROOT, INBOUND]);
      const ev = await collectorOver(repo).collect(['spec-2']);
      expect(ev.originContent).toBe(OUTSIDER_INBOUND);
    });

    it('has no origin for a turn that was not delegated', async () => {
      const repo = chainRepo([ROOT, INBOUND]);
      const ev = await collectorOver(repo).collect(['coord-task']);
      expect(ev.unavailable).toBe(false);
      expect(ev).not.toHaveProperty('originContent');
      expect(ev).not.toHaveProperty('originKind');
      expect(repo.findById).toHaveBeenCalledTimes(1);
      expect(repo.findInjectedInboundIds).not.toHaveBeenCalled();
    });

    it.each([
      ['the origin task is missing', [delegated('spec-task', 'gone')]],
      ['the origin has no taskEventId', [delegated('spec-task', undefined)]],
      ['the origin taskEventId is not a string', [delegated('spec-task', 42)]],
      ['the origin row is not an agent.task', [delegated('spec-task', 'x'), row({ id: 'x', eventType: 'tool.result', payload: { content: 'x' } })]],
      ['the chain loops', [delegated('a', 'b'), delegated('b', 'a')]],
      ['the root task has no content', [delegated('spec-task', 'coord-task'), row({ id: 'coord-task', eventType: 'agent.task', payload: { metadata: {} } })]],
      ['the root inbound has no content', [delegated('spec-task', 'coord-task'), ROOT, row({ id: 'inbound-1', eventType: 'inbound.message', payload: {} })]],
    ])('is unavailable, flagged unresolved, when %s', async (_label, rows) => {
      const first = rows[0]!.id;
      const ev = await collectorOver(chainRepo(rows)).collect([first]);
      expect(ev.unavailable).toBe(true);
      expect(ev.originUnresolved).toBe(true);
      expect(ev.authority).toEqual({ originator: null, liveTurn: false });
    });

    it('is unavailable when delegationOrigin is malformed', async () => {
      const bad = row({ id: 'spec-task', eventType: 'agent.task', payload: { content: 'x', metadata: { delegationOrigin: 'coord-task' } } });
      expect((await collectorOver(chainRepo([bad])).collect(['spec-task'])).originUnresolved).toBe(true);
    });

    it(`stops after ${DELEGATION_MAX_HOPS} hops`, async () => {
      // A chain one hop longer than the bound: spec-0 → … → spec-N → root.
      const rows = Array.from({ length: DELEGATION_MAX_HOPS + 1 }, (_, i) =>
        delegated(`spec-${i}`, i === DELEGATION_MAX_HOPS ? 'coord-task' : `spec-${i + 1}`));
      const repo = chainRepo([...rows, ROOT, INBOUND]);
      expect((await collectorOver(repo).collect(['spec-0'])).unavailable).toBe(true);
      // A chain at the bound is followed.
      const atBound = chainRepo([...rows.slice(1), ROOT, INBOUND]);
      expect((await collectorOver(atBound).collect(['spec-1'])).originContent).toBe(OUTSIDER_INBOUND);
    });

    it('is unavailable, but not flagged unresolved, when reading the origin throws', async () => {
      const repo = chainRepo([delegated('spec-task', 'coord-task')]);
      repo.findById.mockImplementation(async (id: string) => {
        if (id === 'spec-task') return delegated('spec-task', 'coord-task');
        throw new Error('db down');
      });
      const ev = await collectorOver(repo).collect(['spec-task']);
      expect(ev.unavailable).toBe(true);
      expect(ev).not.toHaveProperty('originUnresolved');
    });

    it('redacts credentials, keeps both ends of a padded message, and keeps the origin ahead of the tool results', async () => {
      const padded = row({
        id: 'inbound-1', eventType: 'inbound.message',
        payload: { content: `key sk-ant-abcdefghijklmnopqrstuvwxyz0123 Hello. ${'y'.repeat(EVIDENCE_ORIGIN_MAX_CHARS * 2)} ${OUTSIDER_INBOUND}` },
      });
      const big = 'x'.repeat(EVIDENCE_RESULT_MAX_CHARS * 3);
      const results = Array.from({ length: 20 }, (_, i) =>
        row({ id: `r${i}`, payload: { toolName: `t${i}`, result: { success: true, data: big } } }));
      const ev = await collectorOver(chainRepo([delegated('spec-task', 'coord-task'), ROOT, padded], results)).collect(['spec-task']);
      expect(ev.originContent).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
      expect(ev.originContent).toContain('Hello.');
      // Padding ahead of the push cannot cut it.
      expect(ev.originContent).toContain(OUTSIDER_INBOUND);
      expect(ev.originContent).toMatch(/characters left out/);
      expect(ev.originContent!.length).toBeLessThanOrEqual(EVIDENCE_ORIGIN_MAX_CHARS);
      const resultChars = ev.toolResults.reduce((n, r) => n + r.result.length, 0);
      expect(resultChars + ev.originContent!.length).toBeLessThanOrEqual(EVIDENCE_TOTAL_MAX_CHARS);
      expect(ev.toolResults.length).toBeGreaterThan(0);
    });
  });

  describe('clipMiddle', () => {
    it('leaves short text alone and trims long text to the cap, keeping both ends', () => {
      expect(clipMiddle('short', 100)).toBe('short');
      const out = clipMiddle(`HEAD${'m'.repeat(10_000)}TAIL`, 500);
      expect(out.length).toBeLessThanOrEqual(500);
      expect(out.startsWith('HEAD')).toBe(true);
      expect(out.endsWith('TAIL')).toBe(true);
    });

    it('holds the bound at the edges', () => {
      expect(clipMiddle('x'.repeat(500), 500)).toBe('x'.repeat(500));
      expect(clipMiddle('x'.repeat(501), 500).length).toBeLessThanOrEqual(500);
      // A cap smaller than the marker keeps nothing of the text rather than slicing backwards.
      expect(clipMiddle('x'.repeat(100), 10)).not.toContain('x');
    });
  });

  describe('authority: who directed the work (#2312)', () => {
    it('reads a live principal turn: originator from metadata, liveTurn from the payload', async () => {
      const task = row({
        id: 'task-1', eventType: 'agent.task', parentEventId: null,
        payload: { content: 'Send Sam my number', liveTurn: true, metadata: { originator: PRINCIPAL_SIGNAL } },
      });
      const taskRepo = noTasks();
      const collector = new SendEvidenceCollector({ taskRepo, auditLogRepo: makeRepo([], task), principalBlock: () => null, logger });

      const ev = await collector.collect(['task-1']);

      expect(ev.authority).toEqual({
        originator: { contactId: 'principal-1', systemRole: 'principal', tier: 'principal', channel: 'signal', authenticated: true },
        liveTurn: true,
      });
      // No bound task on the turn, so nothing to look up.
      expect(taskRepo.getTask).not.toHaveBeenCalled();
    });

    it('reads a standing-task wake: the bound task and its root, each with its originator, clipped and redacted', async () => {
      const task = row({
        id: 'task-1', eventType: 'agent.task', parentEventId: null,
        payload: {
          content: 'Wake: follow up with Sam',
          metadata: { originator: PRINCIPAL_EMAIL_UNVERIFIED, boundTask: { taskId: 'child', progress: {} } },
        },
      });
      const taskRepo = {
        getTask: vi.fn(async (id: string) => (id === 'child'
          ? taskRow({ id: 'child', parentTaskId: 'root', title: 'Follow up with Sam', description: `key sk-ant-abcdefghijklmnopqrstuvwxyz0123 ${'x'.repeat(EVIDENCE_RESULT_MAX_CHARS * 2)}`, originator: PRINCIPAL_EMAIL_UNVERIFIED })
          : id === 'root'
            ? taskRow({ id: 'root', title: 'Close the Sam deal', description: 'Get Sam to sign.', originator: PRINCIPAL_SIGNAL })
            : null)),
        resolveProjectRootTaskId: vi.fn().mockResolvedValue('root'),
      };
      const collector = new SendEvidenceCollector({ taskRepo, auditLogRepo: makeRepo([], task), principalBlock: () => null, logger });

      const ev = await collector.collect(['task-1']);

      expect(ev.unavailable).toBe(false);
      expect(ev.authority.liveTurn).toBe(false);
      expect(ev.authority.originator).toEqual({ contactId: 'principal-1', systemRole: 'principal', tier: 'principal', channel: 'email', authenticated: false });
      expect(ev.authority.boundTask).toMatchObject({
        taskId: 'child', title: 'Follow up with Sam',
        originator: { contactId: 'principal-1', systemRole: 'principal', tier: 'principal', channel: 'email', authenticated: false },
      });
      expect(ev.authority.boundTask!.description).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
      expect(ev.authority.boundTask!.description).toContain('[REDACTED]');
      expect(ev.authority.boundTask!.description!.length).toBeLessThanOrEqual(EVIDENCE_RESULT_MAX_CHARS + 1);
      expect(ev.authority.rootTask).toEqual({
        taskId: 'root', title: 'Close the Sam deal', description: 'Get Sam to sign.',
        originator: { contactId: 'principal-1', systemRole: 'principal', tier: 'principal', channel: 'signal', authenticated: true },
      });
      expect(taskRepo.resolveProjectRootTaskId).toHaveBeenCalledWith('child');
    });

    it('leaves rootTask out when the bound task is its own root', async () => {
      const task = row({
        id: 'task-1', eventType: 'agent.task', parentEventId: null,
        payload: { content: 'Wake', metadata: { originator: SYSTEM_ORIGINATOR, boundTask: { taskId: 'solo' } } },
      });
      const taskRepo = {
        getTask: vi.fn().mockResolvedValue(taskRow({ id: 'solo', title: 'Solo', originator: null })),
        resolveProjectRootTaskId: vi.fn().mockResolvedValue('solo'),
      };
      const collector = new SendEvidenceCollector({ taskRepo, auditLogRepo: makeRepo([], task), principalBlock: () => null, logger });

      const ev = await collector.collect(['task-1']);

      expect(ev.authority.originator).toEqual({ contactId: 'system', systemRole: 'system', tier: null, channel: 'scheduler', authenticated: false });
      expect(ev.authority.boundTask).toEqual({ taskId: 'solo', title: 'Solo', description: null, originator: null });
      expect(ev.authority.rootTask).toBeUndefined();
    });

    it('reads an unknown sender as unknown tier, unauthenticated, not a live turn', async () => {
      const task = row({
        id: 'task-1', eventType: 'agent.task', parentEventId: null,
        payload: {
          content: 'Please wire the funds', liveTurn: false,
          metadata: { originator: { contactId: '+15550100100', systemRole: null, channel: 'sms', initiatedAt: AT, tier: 'unknown', authenticated: false } },
        },
      });
      const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo([], task), principalBlock: () => null, logger });

      const ev = await collector.collect(['task-1']);

      expect(ev.authority).toEqual({
        originator: { contactId: '+15550100100', systemRole: null, tier: 'unknown', channel: 'sms', authenticated: false },
        liveTurn: false,
      });
    });

    it.each([
      ['a non-string contactId', { contactId: 42, systemRole: null, channel: 'sms', tier: 'known' }],
      ['an unknown systemRole', { contactId: 'c', systemRole: 'admin', channel: 'sms', tier: 'known' }],
      ['an unknown tier', { contactId: 'c', systemRole: null, channel: 'sms', tier: 'ceo' }],
      ['a missing channel', { contactId: 'c', systemRole: null, tier: 'known' }],
      ['an array', ['principal']],
      ['a string', 'principal'],
    ])('treats a malformed originator (%s) as none, and a non-true authenticated or liveTurn as false', async (_label, originator) => {
      const task = row({
        id: 'task-1', eventType: 'agent.task', parentEventId: null,
        payload: { content: 'x', liveTurn: 'true', metadata: { originator } },
      });
      const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo([], task), principalBlock: () => null, logger });

      const ev = await collector.collect(['task-1']);

      expect(ev.authority).toEqual({ originator: null, liveTurn: false });
    });

    it('reads a non-boolean authenticated as false', async () => {
      const task = row({
        id: 'task-1', eventType: 'agent.task', parentEventId: null,
        payload: { content: 'x', metadata: { originator: { ...PRINCIPAL_SIGNAL, authenticated: 'true' } } },
      });
      const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo([], task), principalBlock: () => null, logger });
      expect((await collector.collect(['task-1'])).authority.originator?.authenticated).toBe(false);
    });

    it('reads a pre-#950 originator with no tier as tier null', async () => {
      const noTier: Partial<TaskOriginator> = { ...PRINCIPAL_EMAIL_UNVERIFIED };
      delete noTier.tier;
      const task = row({ id: 'task-1', eventType: 'agent.task', parentEventId: null, payload: { content: 'x', metadata: { originator: noTier } } });
      const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo([], task), principalBlock: () => null, logger });
      expect((await collector.collect(['task-1'])).authority.originator?.tier).toBeNull();
    });

    it('logs a task-repo failure and keeps the evidence, without the tasks', async () => {
      const error = vi.spyOn(logger, 'error');
      const task = row({
        id: 'task-1', eventType: 'agent.task', parentEventId: null,
        payload: { content: 'Wake', metadata: { originator: PRINCIPAL_SIGNAL, boundTask: { taskId: 'child' } } },
      });
      const taskRepo = { getTask: vi.fn().mockRejectedValue(new Error('db down')), resolveProjectRootTaskId: vi.fn() };
      const collector = new SendEvidenceCollector({ taskRepo, auditLogRepo: makeRepo([], task), principalBlock: () => null, logger });

      const ev = await collector.collect(['task-1']);

      expect(ev.unavailable).toBe(false);
      expect(ev.taskContent).toBe('Wake');
      expect(ev.authority).toEqual({
        originator: { contactId: 'principal-1', systemRole: 'principal', tier: 'principal', channel: 'signal', authenticated: true },
        liveTurn: false,
      });
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });

    it('logs a root-resolution failure and keeps the bound task', async () => {
      const task = row({
        id: 'task-1', eventType: 'agent.task', parentEventId: null,
        payload: { content: 'Wake', metadata: { boundTask: { taskId: 'child' } } },
      });
      const taskRepo = {
        getTask: vi.fn().mockResolvedValue(taskRow({ id: 'child', title: 'Child', parentTaskId: 'root' })),
        resolveProjectRootTaskId: vi.fn().mockRejectedValue(new Error('db down')),
      };
      const collector = new SendEvidenceCollector({ taskRepo, auditLogRepo: makeRepo([], task), principalBlock: () => null, logger });

      const ev = await collector.collect(['task-1']);

      expect(ev.authority.originator).toBeNull();
      expect(ev.authority.boundTask?.taskId).toBe('child');
      expect(ev.authority.rootTask).toBeUndefined();
    });

    describe('a reply linked to outreach (linkedTask, #2312)', () => {
      const LINK = { taskId: 't-link', rootTaskId: null, outreachId: 'o-1', linkKind: 'org-domain', strength: 'strong' };
      const OUTSIDER: TaskOriginator = { contactId: 'bookings@acme.example', systemRole: null, channel: 'email', initiatedAt: AT, tier: 'unknown', authenticated: true };
      const ROW = { id: 'o-1', taskId: 't-link', originator: PRINCIPAL_SIGNAL, addresses: ['bookings@acme.example'], contactIds: ['c-acme'], domains: ['acme.example'] };
      const COUNTERPARTY = { addresses: ['bookings@acme.example'], contactIds: ['c-acme'], domains: ['acme.example'] };
      const PRINCIPAL_READ = { contactId: 'principal-1', systemRole: 'principal', tier: 'principal', channel: 'signal', authenticated: true };
      const linkedTurn = (linkedTask: unknown) => row({
        id: 'task-1', eventType: 'agent.task', parentEventId: null,
        payload: { content: 'We have a slot Tuesday — what is the patient\'s number?', metadata: { originator: OUTSIDER, linkedTask } },
      });
      const outreachRepo = (over: Record<string, unknown> = {}) => ({ getById: vi.fn().mockResolvedValue({ ...ROW, ...over }) });
      const linkTasks = (root: string | null = null) => ({
        getTask: vi.fn(async (id: string) => (id === 't-link'
          ? taskRow({ id: 't-link', title: 'Book physio sk-ant-abcdefghijklmnopqrstuvwxyz0123', originator: SYSTEM_ORIGINATOR })
          : id === 'root' ? taskRow({ id: 'root', title: 'Set up the clinic', originator: PRINCIPAL_SIGNAL }) : null)),
        resolveProjectRootTaskId: vi.fn().mockResolvedValue(root),
      });

      it('reads a task link: the task\'s title and originator, its root, the row\'s counterparties, kind and strength', async () => {
        const taskRepo = linkTasks('root');
        const taskOutreachRepo = outreachRepo();
        const collector = new SendEvidenceCollector({ taskRepo, taskOutreachRepo, auditLogRepo: makeRepo([], linkedTurn(LINK)), principalBlock: () => null, logger });

        const ev = await collector.collect(['task-1']);

        expect(ev.authority.linkedTask).toEqual({
          taskId: 't-link', title: 'Book physio [REDACTED]',
          originator: { contactId: 'system', systemRole: 'system', tier: null, channel: 'scheduler', authenticated: false },
          root: { taskId: 'root', title: 'Set up the clinic', originator: PRINCIPAL_READ },
          linkKind: 'org-domain', strength: 'strong',
          counterparty: COUNTERPARTY,
        });
        expect(taskRepo.resolveProjectRootTaskId).toHaveBeenCalledWith('t-link');
        // The row is read for every link: its counterparties decide who the link covers.
        expect(taskOutreachRepo.getById).toHaveBeenCalledWith('o-1');
        // The sender is still the turn's originator: a link never changes who is speaking.
        expect(ev.authority.originator?.systemRole).toBeNull();
      });

      it('leaves the root out when the linked task is its own root', async () => {
        const collector = new SendEvidenceCollector({ taskRepo: linkTasks('t-link'), taskOutreachRepo: outreachRepo(), auditLogRepo: makeRepo([], linkedTurn(LINK)), principalBlock: () => null, logger });
        expect((await collector.collect(['task-1'])).authority.linkedTask).not.toHaveProperty('root');
      });

      it('reads a task-less link (live-turn outreach) from the outreach row\'s originator', async () => {
        const taskRepo = noTasks();
        const taskOutreachRepo = outreachRepo({ taskId: null });
        const collector = new SendEvidenceCollector({
          taskRepo, taskOutreachRepo, auditLogRepo: makeRepo([], linkedTurn({ ...LINK, taskId: null, linkKind: 'inferred', strength: 'weak' })), principalBlock: () => null, logger,
        });

        const ev = await collector.collect(['task-1']);

        expect(ev.authority.linkedTask).toEqual({
          taskId: null, title: null, originator: PRINCIPAL_READ, linkKind: 'inferred', strength: 'weak', counterparty: COUNTERPARTY,
        });
        expect(taskRepo.getTask).not.toHaveBeenCalled();
      });

      it('keeps the link with no originator and no counterparties when its task or row is missing, unreadable, or not wired', async () => {
        const error = vi.spyOn(logger, 'error');
        const warn = vi.spyOn(logger, 'warn');
        try {
          const noRow = { taskRepo: noTasks(), taskOutreachRepo: { getById: vi.fn().mockResolvedValue(null) } };
          const cases = [
            { ...noRow, link: { ...LINK, taskId: null } },
            { taskRepo: noTasks(), taskOutreachRepo: { getById: vi.fn().mockRejectedValue(new Error('db down')) }, link: { ...LINK, taskId: null } },
            { taskRepo: noTasks(), taskOutreachRepo: outreachRepo({ originator: { contactId: 7 }, addresses: 'x', contactIds: null, domains: [1] }), link: { ...LINK, taskId: null } },
            { taskRepo: noTasks(), taskOutreachRepo: undefined, link: { ...LINK, taskId: null } },
            { ...noRow, link: LINK },
            { taskRepo: { getTask: vi.fn().mockRejectedValue(new Error('db down')), resolveProjectRootTaskId: vi.fn() }, taskOutreachRepo: { getById: vi.fn().mockResolvedValue(null) }, link: LINK },
          ];
          for (const c of cases) {
            const collector = new SendEvidenceCollector({
              taskRepo: c.taskRepo, ...(c.taskOutreachRepo ? { taskOutreachRepo: c.taskOutreachRepo } : {}),
              auditLogRepo: makeRepo([], linkedTurn(c.link)), principalBlock: () => null, logger,
            });
            const ev = await collector.collect(['task-1']);
            expect(ev.unavailable).toBe(false);
            expect(ev.authority.linkedTask).toEqual({ taskId: c.link.taskId, title: null, originator: null, linkKind: 'org-domain', strength: 'strong' });
          }
          expect(error).toHaveBeenCalledTimes(2);
          // The unwired repo is said out loud, with ids only.
          expect(warn).toHaveBeenCalledWith({ outreachId: 'o-1', taskId: null }, expect.stringContaining('not wired'));
        } finally {
          error.mockRestore();
          warn.mockRestore();
        }
      });

      it('keeps the task\'s originator but no counterparties when only the row is unreadable', async () => {
        const collector = new SendEvidenceCollector({
          taskRepo: linkTasks(), taskOutreachRepo: { getById: vi.fn().mockRejectedValue(new Error('db down')) }, auditLogRepo: makeRepo([], linkedTurn(LINK)), principalBlock: () => null, logger,
        });
        const linked = (await collector.collect(['task-1'])).authority.linkedTask;
        expect(linked?.originator?.systemRole).toBe('system');
        expect(linked).not.toHaveProperty('counterparty');
      });

      it.each([
        ['an array', [LINK]],
        ['a string', 'strong'],
        ['an unknown strength', { ...LINK, strength: 'STRONG' }],
        ['a boolean strength', { ...LINK, strength: true }],
        ['a missing strength', { ...LINK, strength: undefined }],
        ['an unknown linkKind', { ...LINK, linkKind: 'principal' }],
        ['a non-string taskId', { ...LINK, taskId: 42 }],
        ['an empty taskId', { ...LINK, taskId: '' }],
        ['a missing outreachId', { ...LINK, outreachId: undefined }],
      ])('ignores a malformed linkedTask entirely (%s), with no lookups', async (_label, linkedTask) => {
        const taskRepo = noTasks();
        const taskOutreachRepo = outreachRepo();
        const collector = new SendEvidenceCollector({ taskRepo, taskOutreachRepo, auditLogRepo: makeRepo([], linkedTurn(linkedTask)), principalBlock: () => null, logger });

        const ev = await collector.collect(['task-1']);

        expect(ev.unavailable).toBe(false);
        expect(ev.authority).not.toHaveProperty('linkedTask');
        expect(taskRepo.getTask).not.toHaveBeenCalled();
        expect(taskOutreachRepo.getById).not.toHaveBeenCalled();
      });
    });

    // PR 5 (#2312): the outreach row a linked turn points at, for learning the requester on a yes.
    it('carries the linked outreach id beside the authority, never inside it', async () => {
      const turn = row({
        id: 'task-1', eventType: 'agent.task', parentEventId: null,
        payload: { content: 'x', metadata: { linkedTask: { taskId: null, outreachId: 'o-9', linkKind: 'address', strength: 'strong' } } },
      });
      const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo([], turn), principalBlock: () => null, logger });
      const ev = await collector.collect(['task-1']);
      expect(ev.linkedOutreachId).toBe('o-9');
      expect(JSON.stringify(ev.authority)).not.toContain('o-9');
      expect((await new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo([]), principalBlock: () => null, logger }).collect(['task-1'])))
        .not.toHaveProperty('linkedOutreachId');
    });

    it('carries no authority when the evidence is unavailable', async () => {
      const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo([], null), principalBlock: () => null, logger });
      const ev = await collector.collect(['task-1']);
      expect(ev.unavailable).toBe(true);
      expect(ev.authority).toEqual({ originator: null, liveTurn: false });
    });
  });

  describe('the principal\'s earlier decisions on this thread (#2312)', () => {
    const DECISIONS = [{ counterparty: 'bookings@acme.example', label: 'phone_us', decision: 'yes' as const }];

    it('reads the latest decisions for the send\'s conversation and recipients', async () => {
      const latestFor = vi.fn().mockResolvedValue(DECISIONS);
      const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo([]), disclosureDecisionsRepo: { latestFor }, principalBlock: () => null, logger });
      const ev = await collector.collect(['task-1'], { conversationId: 'conv-T', counterparties: ['bookings@acme.example'] });
      expect(latestFor).toHaveBeenCalledWith('conv-T', ['bookings@acme.example']);
      expect(ev.decisions).toEqual(DECISIONS);
    });

    it('reads none without a conversation, recipients or the repo', async () => {
      const latestFor = vi.fn().mockResolvedValue(DECISIONS);
      const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo([]), disclosureDecisionsRepo: { latestFor }, principalBlock: () => null, logger });
      expect(await collector.collect(['task-1'])).not.toHaveProperty('decisions');
      expect(await collector.collect(['task-1'], { counterparties: ['a@b.example'] })).not.toHaveProperty('decisions');
      expect(await collector.collect(['task-1'], { conversationId: 'conv-T', counterparties: [] })).not.toHaveProperty('decisions');
      expect(latestFor).not.toHaveBeenCalled();
      const unwired = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo([]), principalBlock: () => null, logger });
      expect(await unwired.collect(['task-1'], { conversationId: 'conv-T', counterparties: ['a@b.example'] })).not.toHaveProperty('decisions');
    });

    it('leaves decisions out, and the evidence available, when the read fails', async () => {
      const latestFor = vi.fn().mockRejectedValue(new Error('db down'));
      const collector = new SendEvidenceCollector({ taskRepo: noTasks(), auditLogRepo: makeRepo([]), disclosureDecisionsRepo: { latestFor }, principalBlock: () => null, logger });
      const ev = await collector.collect(['task-1'], { conversationId: 'conv-T', counterparties: ['a@b.example'] });
      expect(ev.unavailable).toBe(false);
      expect(ev).not.toHaveProperty('decisions');
    });
  });
});
