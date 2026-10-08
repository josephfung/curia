import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolManifest } from '../../../src/skills/types.js';
import { discoverableTools } from '../../scenarios/discovery.js';

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

describe('discoverableTools', () => {
  // The tools a tool-registry call can hand the coordinator as kind:'tool', which the
  // runtime makes callable at once (#2050). A bundle's members come back as its skill,
  // so they are reached through skill-activate instead, not here.
  it('lists standalone tools the agent may call, and nothing a bundle owns', () => {
    const tools = new ToolRegistry();
    const skills = new SkillRegistry();
    for (const name of ['drive-download-file', 'web-search', 'task-create', 'task-list']) {
      tools.register(toolManifest(name), noopHandler);
    }
    tools.register(toolManifest('secret-admin', ['other-agent']), noopHandler);
    tools.register(toolManifest('tool-registry'), noopHandler);
    tools.register(toolManifest('skill-activate'), noopHandler);
    skills.register(
      { name: 'tasks', description: 'Tasks', tools: ['task-create', 'task-list'], instructions: '' },
      '/tmp/tasks',
    );

    const found = discoverableTools(tools, skills, 'coordinator');

    expect(found.sort()).toEqual(['drive-download-file', 'web-search']);
  });
});
