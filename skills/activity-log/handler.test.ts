// skills/activity-log/handler.test.ts

import { describe, it, expect, vi } from 'vitest';
import { ActivityLogHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { AuditLogRepo, AuditLogRow } from '../../src/audit/audit-log-repo.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import { createSilentLogger } from '../../src/logger.js';

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: {
      since: '2026-06-25T00:00:00.000Z',
      until: '2026-06-26T00:00:00.000Z',
    },
    secret: (name: string) => { throw new Error(`secret '${name}' not configured in test`); },
    log: createSilentLogger(),
    timezone: 'America/New_York',
    ...overrides,
  } as SkillContext;
}

function makeAuditRow(overrides?: Partial<AuditLogRow>): AuditLogRow {
  return {
    id: 'audit-1',
    timestamp: new Date('2026-06-25T18:00:00.000Z'),
    eventType: 'skill.result',
    sourceLayer: 'execution',
    sourceId: 'calendar',
    conversationId: 'conv-1',
    parentEventId: null,
    payload: {
      skillName: 'calendar-respond-to-invite',
      result: {
        success: true,
        data: {
          response: 'accept',
          event: { title: 'Sync with John Doe' },
          releasedHolds: ['hold-1'],
        },
      },
    },
    ...overrides,
  };
}

describe('ActivityLogHandler', () => {
  it('returns error when auditLogRepo is unavailable', async () => {
    const handler = new ActivityLogHandler();
    const result = await handler.execute(makeCtx({ auditLogRepo: undefined }));
    expect(result.success).toBe(false);
  });

  it('returns RSVP actions with summarized target and detail', async () => {
    const auditLogRepo = {
      findSkillResults: vi.fn().mockResolvedValue([makeAuditRow()]),
    } as unknown as AuditLogRepo;
    const actionLogRepo = {
      findTerminalBetween: vi.fn().mockResolvedValue([
        {
          id: 1,
          skillName: 'calendar-respond-to-invite',
          outcome: 'success',
          conversationId: 'conv-1',
          createdAt: new Date('2026-06-25T18:00:00.000Z'),
        },
      ]),
    } as unknown as ActionLogRepo;

    const handler = new ActivityLogHandler();
    const result = await handler.execute(makeCtx({ auditLogRepo, actionLogRepo }));

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { actions: Array<Record<string, unknown>> } }).data;
    expect(data.actions).toHaveLength(1);
    expect(data.actions[0]).toMatchObject({
      skill: 'calendar-respond-to-invite',
      target: 'accept — Sync with John Doe',
      outcome: 'completed',
      autonomy: 'autonomous',
    });
    expect(data.actions[0]!.detail).toContain('RSVP accept');
  });

  it('filters to calendar-respond-to-invite when skill_name is provided', async () => {
    const auditLogRepo = {
      findSkillResults: vi.fn().mockResolvedValue([makeAuditRow()]),
    } as unknown as AuditLogRepo;

    const handler = new ActivityLogHandler();
    const result = await handler.execute(makeCtx({
      auditLogRepo,
      input: {
        since: '2026-06-25T00:00:00.000Z',
        skill_name: 'calendar-respond-to-invite',
      },
    }));

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { actions: Array<Record<string, unknown>> } }).data;
    expect(data.actions).toHaveLength(1);
    expect(data.actions[0]!.skill).toBe('calendar-respond-to-invite');
    expect(auditLogRepo.findSkillResults).toHaveBeenCalledWith(expect.objectContaining({
      skillNames: ['calendar-respond-to-invite'],
    }));
  });

  it('excludes non-recap skills by default', async () => {
    const auditLogRepo = {
      findSkillResults: vi.fn().mockResolvedValue([
        makeAuditRow({
          payload: {
            skillName: 'memory-query',
            result: { success: true, data: {} },
          },
        }),
      ]),
    } as unknown as AuditLogRepo;

    const handler = new ActivityLogHandler();
    const result = await handler.execute(makeCtx({ auditLogRepo }));

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { count: number } }).data;
    expect(data.count).toBe(0);
  });

  it('labels approved actions when autonomy log matches conversation_id', async () => {
    const auditLogRepo = {
      findSkillResults: vi.fn().mockResolvedValue([makeAuditRow()]),
    } as unknown as AuditLogRepo;
    const actionLogRepo = {
      findTerminalBetween: vi.fn().mockResolvedValue([
        {
          id: 1,
          skillName: 'calendar-respond-to-invite',
          outcome: 'approved',
          conversationId: 'conv-1',
          createdAt: new Date('2026-06-25T18:00:01.000Z'),
        },
        {
          id: 2,
          skillName: 'calendar-respond-to-invite',
          outcome: 'success',
          conversationId: 'conv-other',
          createdAt: new Date('2026-06-25T18:00:01.000Z'),
        },
      ]),
    } as unknown as ActionLogRepo;

    const handler = new ActivityLogHandler();
    const result = await handler.execute(makeCtx({ auditLogRepo, actionLogRepo }));

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { actions: Array<{ autonomy: string }> } }).data;
    expect(data.actions[0]!.autonomy).toBe('approved');
  });

  it('returns unknown autonomy when conversation_id does not match', async () => {
    const auditLogRepo = {
      findSkillResults: vi.fn().mockResolvedValue([makeAuditRow({ conversationId: 'conv-1' })]),
    } as unknown as AuditLogRepo;
    const actionLogRepo = {
      findTerminalBetween: vi.fn().mockResolvedValue([
        {
          id: 1,
          skillName: 'calendar-respond-to-invite',
          outcome: 'success',
          conversationId: 'conv-other',
          createdAt: new Date('2026-06-25T18:00:00.000Z'),
        },
      ]),
    } as unknown as ActionLogRepo;

    const handler = new ActivityLogHandler();
    const result = await handler.execute(makeCtx({ auditLogRepo, actionLogRepo }));

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { actions: Array<{ autonomy: string }> } }).data;
    expect(data.actions[0]!.autonomy).toBe('unknown');
  });
});
