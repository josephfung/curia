import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolManifest } from '../../../src/skills/types.js';
import {
  resolveSkillActivation,
  selectActiveSkillsForWake,
  unifiedToolSearch,
  buildSkillActivationProtocol,
  parseSkillActivationProtocol,
} from '../../../src/skills/skill-activation.js';
import { activateSkillInBlock } from '../../../src/db/active-skills-progress.js';

function toolManifest(
  name: string,
  opts: { allowed_callers?: string[]; description?: string } = {},
): ToolManifest {
  return {
    name,
    description: opts.description ?? `Tool ${name}`,
    version: '0.1.0',
    action_risk: 'none',
    sensitivity: 'normal',
    permissions: [],
    secrets: [],
    timeout: 30000,
    inputs: {},
    outputs: {},
    allowed_callers: opts.allowed_callers,
  };
}

const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };

function setup() {
  const tools = new ToolRegistry();
  const skills = new SkillRegistry();

  for (const name of ['task-create', 'task-list', 'task-update', 'task-complete']) {
    tools.register(toolManifest(name, { description: `Manage tasks via ${name}` }), noopHandler);
  }
  tools.register(
    toolManifest('secret-admin', { allowed_callers: ['coordinator'], description: 'Admin only' }),
    noopHandler,
  );
  tools.register(toolManifest('web-search', { description: 'Search the web' }), noopHandler);
  tools.register(toolManifest('tool-registry', { description: 'Discover tools' }), noopHandler);

  skills.register(
    {
      name: 'tasks',
      description: 'Defer and track multi-step work with tasks',
      tools: ['task-create', 'task-list', 'task-update', 'task-complete'],
      instructions: '## Task Management\nDecide, don\'t drop.',
    },
    '/tmp/tasks',
  );
  skills.register(
    {
      name: 'admin-bundle',
      description: 'Admin tools',
      tools: ['secret-admin'],
      instructions: 'Be careful.',
    },
    '/tmp/admin',
  );
  // Synthetic singleton for web-search (orphan flat tool)
  skills.register(
    {
      name: 'web-search',
      description: 'Search the web',
      tools: ['web-search'],
      instructions: '',
    },
    '/tmp/web-search',
    { synthetic: true },
  );

  return { tools, skills };
}

describe('unifiedToolSearch', () => {
  it('returns kind:skill for matching bundles and promotes member atoms', () => {
    const { tools, skills } = setup();
    const hits = unifiedToolSearch({
      query: 'task-create',
      toolRegistry: tools,
      skillRegistry: skills,
      agentId: 'coordinator',
    });
    expect(hits.some((h) => h.kind === 'skill' && h.name === 'tasks')).toBe(true);
    expect(hits.some((h) => h.name === 'task-create')).toBe(false);
  });

  it('returns kind:tool for synthetic-owned / orphan tools', () => {
    const { tools, skills } = setup();
    const hits = unifiedToolSearch({
      query: 'web',
      toolRegistry: tools,
      skillRegistry: skills,
      agentId: 'coordinator',
    });
    expect(hits).toContainEqual({
      name: 'web-search',
      description: 'Search the web',
      kind: 'tool',
    });
  });

  it('hides tools whose allowed_callers excludes the agent', () => {
    const { tools, skills } = setup();
    // Promote via skill description match for admin-bundle
    const hits = unifiedToolSearch({
      query: 'Admin',
      toolRegistry: tools,
      skillRegistry: skills,
      agentId: 'research-analyst',
    });
    // Skill itself may still appear (activation will skip disallowed tools)
    expect(hits.some((h) => h.name === 'secret-admin')).toBe(false);
  });

  it('excludes tool-registry and skill-activate from results', () => {
    const { tools, skills } = setup();
    tools.register(toolManifest('skill-activate', { description: 'Activate a skill' }), noopHandler);
    const hits = unifiedToolSearch({
      query: '',
      toolRegistry: tools,
      skillRegistry: skills,
      agentId: 'coordinator',
    });
    expect(hits.map((h) => h.name)).not.toContain('tool-registry');
    expect(hits.map((h) => h.name)).not.toContain('skill-activate');
  });
});

describe('resolveSkillActivation', () => {
  it('returns tools + instructions for a real skill', () => {
    const { tools, skills } = setup();
    const result = resolveSkillActivation({
      skillName: 'tasks',
      skillRegistry: skills,
      toolRegistry: tools,
      agentId: 'coordinator',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.tools).toEqual(['task-create', 'task-list', 'task-update', 'task-complete']);
    expect(result.instructions).toContain('Task Management');
    expect(result.skippedTools).toEqual([]);
  });

  it('does not widen authority — skips tools the agent cannot call', () => {
    const { tools, skills } = setup();
    const result = resolveSkillActivation({
      skillName: 'admin-bundle',
      skillRegistry: skills,
      toolRegistry: tools,
      agentId: 'research-analyst',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.tools).toEqual([]);
    expect(result.skippedTools).toEqual(['secret-admin']);
  });

  it('rejects synthetic skills', () => {
    const { tools, skills } = setup();
    const result = resolveSkillActivation({
      skillName: 'web-search',
      skillRegistry: skills,
      toolRegistry: tools,
      agentId: 'coordinator',
    });
    expect(result).toEqual({
      error: expect.stringContaining('synthetic'),
    });
  });

  it('round-trips the activation protocol payload', () => {
    const { tools, skills } = setup();
    const resolved = resolveSkillActivation({
      skillName: 'tasks',
      skillRegistry: skills,
      toolRegistry: tools,
      agentId: 'coordinator',
    });
    expect('error' in resolved).toBe(false);
    if ('error' in resolved) return;
    const parsed = parseSkillActivationProtocol(buildSkillActivationProtocol(resolved));
    expect(parsed).toEqual(resolved);
  });
});

describe('selectActiveSkillsForWake', () => {
  it('keeps relevant skills as a strong prior and drops pinned', () => {
    const { skills } = setup();
    let progress: Record<string, unknown> = {};
    const block = activateSkillInBlock(
      activateSkillInBlock(null, 'tasks', '2026-07-21T00:00:00.000Z'),
      'admin-bundle',
      '2026-07-21T01:00:00.000Z',
    );
    progress = { activeSkills: block };

    const selected = selectActiveSkillsForWake({
      progress,
      pinnedSkillNames: ['admin-bundle'],
      skillRegistry: skills,
      relevanceText: 'please create a task for the board deck',
      cap: 5,
    });
    expect(selected).toEqual(['tasks']);
  });

  it('caps and drops irrelevant when any skill still matches', () => {
    const { skills } = setup();
    skills.register(
      {
        name: 'calendar',
        description: 'Google Calendar scheduling',
        tools: [],
        instructions: '',
      },
      '/tmp/calendar',
    );
    skills.register(
      {
        name: 'email',
        description: 'Send email',
        tools: [],
        instructions: '',
      },
      '/tmp/email',
    );

    let block = activateSkillInBlock(null, 'email', '2026-07-21T00:00:00.000Z');
    block = activateSkillInBlock(block, 'calendar', '2026-07-21T01:00:00.000Z');
    block = activateSkillInBlock(block, 'tasks', '2026-07-21T02:00:00.000Z');

    const selected = selectActiveSkillsForWake({
      progress: { activeSkills: block },
      pinnedSkillNames: [],
      skillRegistry: skills,
      relevanceText: 'reschedule the calendar meeting',
      cap: 5,
    });
    // Only calendar shares a whole token with the step — email/tasks are dropped.
    expect(selected).toEqual(['calendar']);
  });

  it('does not match substring tokens (multitask ≠ task)', () => {
    const { skills } = setup();
    let block = activateSkillInBlock(null, 'tasks', '2026-07-21T00:00:00.000Z');
    const selected = selectActiveSkillsForWake({
      progress: { activeSkills: block },
      pinnedSkillNames: [],
      skillRegistry: skills,
      relevanceText: 'finish the multitask spreadsheet review',
      cap: 5,
    });
    // No whole-token overlap → fall back to MRU (tasks still returned).
    expect(selected).toEqual(['tasks']);
  });

  it('falls back to MRU when nothing is relevant', () => {
    const { skills } = setup();
    skills.register(
      {
        name: 'calendar',
        description: 'Google Calendar scheduling',
        tools: [],
        instructions: '',
      },
      '/tmp/calendar',
    );
    let block = activateSkillInBlock(null, 'tasks', '2026-07-21T00:00:00.000Z');
    block = activateSkillInBlock(block, 'calendar', '2026-07-21T01:00:00.000Z');
    const selected = selectActiveSkillsForWake({
      progress: { activeSkills: block },
      pinnedSkillNames: [],
      skillRegistry: skills,
      relevanceText: 'xyzzy completely unrelated',
      cap: 1,
    });
    expect(selected).toEqual(['calendar']); // MRU
  });
});
