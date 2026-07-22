import { describe, it, expect, vi } from 'vitest';
import handler from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import { SkillRegistry } from '../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../src/skills/registry.js';
import type { ToolManifest } from '../../src/skills/types.js';
import { SKILL_ACTIVATION_PROTOCOL } from '../../src/skills/skill-activation.js';
import { readActiveSkillsBlock } from '../../src/db/active-skills-progress.js';

function toolManifest(name: string, allowed_callers?: string[]): ToolManifest {
  return {
    name,
    description: `Tool ${name}`,
    version: '0.1.0',
    action_risk: 'none',
    sensitivity: 'normal',
    permissions: [],
    secrets: [],
    timeout: 30000,
    inputs: {},
    outputs: {},
    allowed_callers,
  };
}

const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const tools = new ToolRegistry();
  tools.register(toolManifest('task-create'), noopHandler);
  tools.register(toolManifest('task-list'), noopHandler);
  tools.register(toolManifest('secret-admin', ['coordinator']), noopHandler);

  const skills = new SkillRegistry();
  skills.register(
    {
      name: 'tasks',
      description: 'Task management',
      tools: ['task-create', 'task-list'],
      instructions: '## Task Management\nOwn the how.',
    },
    '/tmp/tasks',
  );
  skills.register(
    {
      name: 'admin-bundle',
      description: 'Admin',
      tools: ['secret-admin'],
      instructions: 'Careful.',
    },
    '/tmp/admin',
  );

  return {
    input: {},
    toolName: 'skill-activate',
    toolVersion: '0.1.1',
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    } as unknown as ToolContext['log'],
    secret: () => '',
    agentId: 'research-analyst',
    skillRegistry: skills,
    toolRegistry: tools,
    ...overrides,
  };
}

describe('skill-activate handler', () => {
  it('activates a skill and returns protocol payload with instructions', async () => {
    const ctx = makeCtx({ input: { skill: 'tasks' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as Record<string, unknown>;
    expect(data._curia_protocol).toBe(SKILL_ACTIVATION_PROTOCOL);
    expect(data.skill).toBe('tasks');
    expect(data.tools).toEqual(['task-create', 'task-list']);
    expect(data.instructionsLoaded).toBe(true);
    expect(String(data.instructions)).toContain('Task Management');
  });

  it('does not surface tools the agent is not allowed to call', async () => {
    const ctx = makeCtx({
      input: { skill: 'admin-bundle' },
      agentId: 'research-analyst',
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { tools: string[]; skippedTools: string[] };
    expect(data.tools).toEqual([]);
    expect(data.skippedTools).toEqual(['secret-admin']);
  });

  it('persists activeSkills only for the bound task from taskMetadata', async () => {
    const taskId = '11111111-1111-4111-8111-111111111111';
    const progress: Record<string, unknown> = {};
    const setActiveSkillsBlock = vi.fn(async (_id: string, block: unknown) => {
      progress.activeSkills = block;
      return { task: { id: taskId, progress }, block };
    });
    const ctx = makeCtx({
      input: { skill: 'tasks' },
      taskMetadata: {
        boundTask: { taskId, errorBudget: {}, progress: {} },
      },
      taskRepo: {
        getTask: async () => ({ id: taskId, progress, status: 'open' }),
        setActiveSkillsBlock,
      } as unknown as ToolContext['taskRepo'],
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(setActiveSkillsBlock).toHaveBeenCalledOnce();
    expect(setActiveSkillsBlock.mock.calls[0]![0]).toBe(taskId);
    expect(readActiveSkillsBlock(progress)?.skills.map((s) => s.name)).toEqual(['tasks']);
  });

  it('ignores LLM-supplied task_id and does not write without a bound task', async () => {
    const setActiveSkillsBlock = vi.fn();
    const ctx = makeCtx({
      // LLM might still hallucinate task_id — must be ignored.
      input: { skill: 'tasks', task_id: '11111111-1111-4111-8111-111111111111' },
      taskRepo: {
        getTask: vi.fn(),
        setActiveSkillsBlock,
      } as unknown as ToolContext['taskRepo'],
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(setActiveSkillsBlock).not.toHaveBeenCalled();
  });

  it('rejects unknown skills', async () => {
    const ctx = makeCtx({ input: { skill: 'nope' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('Unknown skill');
  });
});
