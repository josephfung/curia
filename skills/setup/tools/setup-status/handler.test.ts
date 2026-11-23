// skills/setup-status/handler.test.ts
//
// The checklist itself is tested in tests/unit/setup/checklist.test.ts. This file covers
// what the tool adds: deferral of optional extras, and its error paths.
import { describe, it, expect, vi } from 'vitest';
import { SetupStatusHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { EntityMemory } from '../../../../src/memory/entity-memory.js';
import type { SetupChecklist, SetupChecklistTask } from '../../../../src/setup/checklist.js';

function checklistTask(id: string, status: 'done' | 'pending', optional = false): SetupChecklistTask {
  return {
    id, label: id, value_prop: 'v', tier: 'instant', handoff: 'console', optional, status,
    credential_how_to: null, docs_url: null,
  };
}

/** An EntityMemory double holding `setup_wizard/deferrals`, as ConfigStore reads it. */
function entityMemoryWith(deferrals?: string): EntityMemory {
  const anchor = {
    id: 'anchor-1', label: 'config:setup_wizard', type: 'concept', aliases: [],
    properties: { category: 'config', namespace: 'setup_wizard' },
    temporal: { lastConfirmedAt: new Date(), confidence: 0.7, decayClass: 'permanent', source: 'system:config-store' },
    sensitivity: 'internal',
  };
  const fact = {
    id: 'fact-1', label: 'deferrals', type: 'fact', aliases: [],
    properties: { key: 'deferrals', value: deferrals, namespace: 'setup_wizard' },
    temporal: { lastConfirmedAt: new Date(), confidence: 0.9, decayClass: 'permanent', source: 'system:config-store' },
    sensitivity: 'internal',
  };
  return {
    findEntities: vi.fn(async () => (deferrals === undefined ? [] : [anchor])),
    getFacts: vi.fn(async () => (deferrals === undefined ? [] : [fact])),
  } as unknown as EntityMemory;
}

function ctx(checklist: SetupChecklist | Error | undefined, deferrals?: string): ToolContext {
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return {
    input: {},
    secret: () => { throw new Error('no secrets'); },
    log,
    entityMemory: entityMemoryWith(deferrals),
    setupChecklist: checklist === undefined
      ? undefined
      : checklist instanceof Error
        ? async () => { throw checklist; }
        : async () => checklist,
  } as unknown as ToolContext;
}

const CHECKLIST: SetupChecklist = {
  setupFor: 'other',
  tasks: [
    checklistTask('email', 'pending'),
    checklistTask('voice', 'done'),
    checklistTask('web_browser', 'pending', true),
  ],
  setupComplete: false,
  missing: ['email'],
};

describe('SetupStatusHandler', () => {
  it('returns the checklist with setup_complete, missing and a summary', async () => {
    const result = await new SetupStatusHandler().execute(ctx(CHECKLIST));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { setup_complete: boolean; missing: string[]; summary: Record<string, number> };
    expect(data.setup_complete).toBe(false);
    expect((data as unknown as { setup_for: string }).setup_for).toBe('other');
    expect(data.missing).toEqual(['email']);
    expect(data.summary).toEqual({ total: 3, done: 1, pending: 2, deferred: 0 });
  });

  it('marks a deferred optional extra as deferred', async () => {
    const result = await new SetupStatusHandler().execute(ctx(CHECKLIST, '["web_browser"]'));
    if (!result.success) throw new Error(result.error);
    const tasks = (result.data as { tasks: Array<{ id: string; status: string }> }).tasks;
    expect(tasks.find((t) => t.id === 'web_browser')?.status).toBe('deferred');
  });

  it('ignores a deferral stored for a required step: required steps cannot be deferred', async () => {
    const result = await new SetupStatusHandler().execute(ctx(CHECKLIST, '["email"]'));
    if (!result.success) throw new Error(result.error);
    const tasks = (result.data as { tasks: Array<{ id: string; status: string }> }).tasks;
    expect(tasks.find((t) => t.id === 'email')?.status).toBe('pending');
  });

  it('reports done over deferred', async () => {
    const result = await new SetupStatusHandler().execute(ctx(CHECKLIST, '["voice"]'));
    if (!result.success) throw new Error(result.error);
    const tasks = (result.data as { tasks: Array<{ id: string; status: string }> }).tasks;
    expect(tasks.find((t) => t.id === 'voice')?.status).toBe('done');
  });

  it('treats malformed deferrals as none', async () => {
    const c = ctx(CHECKLIST, 'not json');
    const result = await new SetupStatusHandler().execute(c);
    expect(result.success).toBe(true);
    expect(c.log.warn).toHaveBeenCalled();
  });

  it('fails without the setupChecklist capability', async () => {
    const result = await new SetupStatusHandler().execute(ctx(undefined));
    expect(result).toEqual({ success: false, error: expect.stringMatching(/setupChecklist/) });
  });

  it('fails, and logs, when the checklist cannot be computed', async () => {
    const c = ctx(new Error('catalog unreadable'));
    const result = await new SetupStatusHandler().execute(c);
    expect(result).toEqual({ success: false, error: 'catalog unreadable' });
    expect(c.log.error).toHaveBeenCalled();
  });
});
