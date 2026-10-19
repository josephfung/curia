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
} from '../../../src/autonomy/send-evidence.js';
import type { AuditLogRow } from '../../../src/audit/audit-log-repo.js';
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

function makeRepo(results: AuditLogRow[], task: AuditLogRow | null = TASK) {
  return {
    findById: vi.fn().mockResolvedValue(task),
    findToolResultsForTasks: vi.fn().mockResolvedValue(results),
  };
}

const logger = createSilentLogger();

describe('SendEvidenceCollector', () => {
  it('collects the task content, progress and tool results, newest first', async () => {
    const repo = makeRepo([
      row({ id: 'c', timestamp: new Date(3), payload: { toolName: 'contact-lookup', result: { success: true, data: { name: 'Dana' } } } }),
      row({ id: 'a', timestamp: new Date(1), payload: { toolName: 'calendar-list', result: { success: true, data: { free: true } } } }),
    ]);
    const collector = new SendEvidenceCollector({ auditLogRepo: repo, principalBlock: () => '## Who you serve', logger });

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
    const collector = new SendEvidenceCollector({ auditLogRepo: makeRepo(results), principalBlock: () => null, logger });

    const ev = await collector.collect(['task-1']);

    expect(ev.toolResults[0]!.result.length).toBeLessThanOrEqual(EVIDENCE_RESULT_MAX_CHARS + 1);
    expect(ev.toolResults.reduce((n, r) => n + r.result.length, 0)).toBeLessThanOrEqual(EVIDENCE_TOTAL_MAX_CHARS);
    expect(ev.toolResults.length).toBeGreaterThan(0);
    expect(ev.toolResults[0]!.toolName).toBe('t19');
  });

  it('reads several turns in one query, describing the latest (a relay rewrite and the turn it rewrote)', async () => {
    const repo = makeRepo([]);
    const collector = new SendEvidenceCollector({ auditLogRepo: repo, principalBlock: () => null, logger });

    await collector.collect(['task-1', 'task-2']);

    expect(repo.findToolResultsForTasks).toHaveBeenCalledWith(['task-1', 'task-2'], expect.any(Number));
    expect(repo.findById).toHaveBeenCalledWith('task-2');
  });

  it('reads pre-ADR-031 skill.result rows too', async () => {
    const repo = makeRepo([row({ eventType: 'skill.result', payload: { skillName: 'legacy', result: { success: true, data: 1 } } })]);
    const collector = new SendEvidenceCollector({ auditLogRepo: repo, principalBlock: () => null, logger });
    expect((await collector.collect(['task-1'])).toolResults.map((r) => r.toolName)).toEqual(['legacy']);
  });

  it('redacts credentials before they reach the judge\'s provider, but keeps contact facts', async () => {
    const repo = makeRepo([row({ payload: {
      toolName: 'web-fetch',
      result: { success: true, data: { key: 'sk-ant-abcdefghijklmnopqrstuvwxyz0123', phone: '+1 555 010 0199' } },
    } })]);
    const collector = new SendEvidenceCollector({ auditLogRepo: repo, principalBlock: () => null, logger });

    const ev = await collector.collect(['task-1']);

    expect(ev.toolResults[0]!.result).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(ev.toolResults[0]!.result).toContain('[REDACTED]');
    // Grounding checks claims like "Dana's number is …" against this, so contact data stays.
    expect(ev.toolResults[0]!.result).toContain('+1 555 010 0199');
  });

  it('marks the evidence unavailable when the audit lookup fails', async () => {
    const repo = { findById: vi.fn().mockRejectedValue(new Error('db down')), findToolResultsForTasks: vi.fn() };
    const collector = new SendEvidenceCollector({ auditLogRepo: repo, principalBlock: () => null, logger });

    const ev = await collector.collect(['task-1']);

    expect(ev.unavailable).toBe(true);
    expect(ev.toolResults).toEqual([]);
  });

  it('marks the evidence unavailable when the drafting turn\'s task row is missing', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const collector = new SendEvidenceCollector({ auditLogRepo: makeRepo([], null), principalBlock: () => null, logger });

    const ev = await collector.collect(['task-1']);

    expect(ev.unavailable).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is unavailable, with a warning, when there is no task to read', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const repo = makeRepo([]);
    const collector = new SendEvidenceCollector({ auditLogRepo: repo, principalBlock: () => null, logger });

    expect((await collector.collect([])).unavailable).toBe(true);
    expect(repo.findById).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
