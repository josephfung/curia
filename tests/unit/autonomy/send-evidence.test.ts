// send-evidence.test.ts — the drafting turn's lookups, read back from audit_log (#2159).

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
    conversationId: null, taskId: null, parentEventId: 'task-1', payload: {}, action: null, outcome: null,
    targetType: null, targetId: null, initiatorType: null, initiatorId: null, entryHash: null, ...over,
  };
}

const logger = createSilentLogger();

describe('SendEvidenceCollector', () => {
  it('collects the task content, progress and tool results, newest first', async () => {
    const repo = {
      findById: vi.fn().mockResolvedValue(row({
        id: 'task-1', eventType: 'agent.task',
        payload: { content: 'Can you confirm Tuesday?', metadata: { boundTask: { taskId: 't', progress: { step: 2 } } } },
      })),
      findChildren: vi.fn().mockResolvedValue([
        row({ id: 'a', timestamp: new Date(1), payload: { toolName: 'calendar-list', result: { success: true, data: { free: true } } } }),
        row({ id: 'b', eventType: 'tool.invoke', timestamp: new Date(2), payload: { toolName: 'x' } }),
        row({ id: 'c', timestamp: new Date(3), payload: { toolName: 'contact-lookup', result: { success: true, data: { name: 'Dana' } } } }),
      ]),
    };
    const collector = new SendEvidenceCollector({ auditLogRepo: repo, principalBlock: () => '## Who you serve', logger });

    const ev = await collector.collect(['task-1']);

    expect(ev.unavailable).toBe(false);
    expect(ev.taskContent).toBe('Can you confirm Tuesday?');
    expect(ev.taskProgress).toBe('{"step":2}');
    expect(ev.principalBlock).toBe('## Who you serve');
    expect(ev.toolResults.map((r) => r.toolName)).toEqual(['contact-lookup', 'calendar-list']);
    expect(ev.toolResults[0]!.result).toContain('Dana');
  });

  it('trims each result and the total', async () => {
    const big = 'x'.repeat(EVIDENCE_RESULT_MAX_CHARS * 3);
    const children = Array.from({ length: 20 }, (_, i) =>
      row({ id: `r${i}`, timestamp: new Date(i), payload: { toolName: `t${i}`, result: { success: true, data: big } } }));
    const repo = { findById: vi.fn().mockResolvedValue(null), findChildren: vi.fn().mockResolvedValue(children) };
    const collector = new SendEvidenceCollector({ auditLogRepo: repo, principalBlock: () => null, logger });

    const ev = await collector.collect(['task-1']);

    expect(ev.toolResults[0]!.result.length).toBeLessThanOrEqual(EVIDENCE_RESULT_MAX_CHARS + 1);
    expect(ev.toolResults.reduce((n, r) => n + r.result.length, 0)).toBeLessThanOrEqual(EVIDENCE_TOTAL_MAX_CHARS);
    expect(ev.toolResults.length).toBeGreaterThan(0);
    expect(ev.toolResults[0]!.toolName).toBe('t19');
  });

  it('merges several turns (a relay rewrite and the turn it rewrote)', async () => {
    const repo = {
      findById: vi.fn().mockResolvedValue(null),
      findChildren: vi.fn()
        .mockResolvedValueOnce([row({ id: 'a', timestamp: new Date(1), payload: { toolName: 'first', result: { success: true, data: 1 } } })])
        .mockResolvedValueOnce([row({ id: 'b', timestamp: new Date(5), payload: { toolName: 'second', result: { success: true, data: 2 } } })]),
    };
    const collector = new SendEvidenceCollector({ auditLogRepo: repo, principalBlock: () => null, logger });

    const ev = await collector.collect(['task-1', 'task-2']);

    expect(ev.toolResults.map((r) => r.toolName)).toEqual(['second', 'first']);
    // The latest turn's task row describes what the message answers.
    expect(repo.findById).toHaveBeenCalledWith('task-2');
  });

  it('reads pre-ADR-031 skill.result rows too', async () => {
    const repo = {
      findById: vi.fn().mockResolvedValue(null),
      findChildren: vi.fn().mockResolvedValue([
        row({ eventType: 'skill.result', payload: { skillName: 'legacy', result: { success: true, data: 1 } } }),
      ]),
    };
    const collector = new SendEvidenceCollector({ auditLogRepo: repo, principalBlock: () => null, logger });
    expect((await collector.collect(['task-1'])).toolResults.map((r) => r.toolName)).toEqual(['legacy']);
  });

  it('marks the evidence unavailable when the audit lookup fails', async () => {
    const repo = { findById: vi.fn().mockRejectedValue(new Error('db down')), findChildren: vi.fn() };
    const collector = new SendEvidenceCollector({ auditLogRepo: repo, principalBlock: () => null, logger });

    const ev = await collector.collect(['task-1']);

    expect(ev.unavailable).toBe(true);
    expect(ev.toolResults).toEqual([]);
  });

  it('is unavailable with no task to read', async () => {
    const repo = { findById: vi.fn(), findChildren: vi.fn() };
    const collector = new SendEvidenceCollector({ auditLogRepo: repo, principalBlock: () => null, logger });
    expect((await collector.collect([])).unavailable).toBe(true);
    expect(repo.findById).not.toHaveBeenCalled();
  });
});
