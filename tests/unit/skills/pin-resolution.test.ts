import { describe, it, expect } from 'vitest';
import { parseSkillMd } from '../../../src/skills/skill-md.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { resolvePinnedSkills, appendSkillInstructions } from '../../../src/skills/pin-resolution.js';
import { registerSyntheticSingletonSkills } from '../../../src/skills/skill-loader.js';
import type { ToolManifest } from '../../../src/skills/types.js';
import { TASK_MANAGEMENT_TOOLS } from '../../../src/agents/task-management.js';

function toolManifest(name: string, action_risk: ToolManifest['action_risk'] = 'none'): ToolManifest {
  return {
    name,
    description: `Tool ${name}`,
    version: '0.1.0',
    action_risk,
    sensitivity: 'normal',
    permissions: [],
    secrets: [],
    timeout: 30000,
    inputs: {},
    outputs: {},
  };
}

const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };

describe('parseSkillMd', () => {
  it('parses Anthropic-compatible frontmatter + body', () => {
    const parsed = parseSkillMd(`---
name: task-management
description: Track work with tasks.
version: "0.1.0"
heartbeat: true
document_workspace: true
tools:
  - task-create
  - task-list
---

## Task Management

Do the work.
`);
    expect(parsed.name).toBe('task-management');
    expect(parsed.heartbeat).toBe(true);
    expect(parsed.document_workspace).toBe(true);
    expect(parsed.tools).toEqual(['task-create', 'task-list']);
    expect(parsed.instructions).toContain('## Task Management');
  });

  it('rejects missing name', () => {
    expect(() => parseSkillMd('---\ndescription: x\n---\n')).toThrow(/name/);
  });
});

describe('resolvePinnedSkills', () => {
  it('expands a bundle to member tools and injects instructions + flags', () => {
    const tools = new ToolRegistry();
    for (const name of TASK_MANAGEMENT_TOOLS) {
      tools.register(toolManifest(name, 'low'), noopHandler);
    }
    tools.register(toolManifest('doc-read', 'none'), noopHandler);

    const skills = new SkillRegistry();
    skills.register({
      name: 'task-management',
      description: 'tasks',
      version: '0.1.0',
      tools: [...TASK_MANAGEMENT_TOOLS, 'doc-read'],
      instructions: '## Task Management\n\nDo it.',
      heartbeat: true,
      document_workspace: true,
    }, '/tmp/task-management');

    const r = resolvePinnedSkills(['task-management'], skills, tools);
    expect(r.toolNames).toEqual([...TASK_MANAGEMENT_TOOLS, 'doc-read']);
    expect(r.heartbeatEligible).toBe(true);
    expect(r.documentWorkspaceEnabled).toBe(true);
    expect(r.instructionBlocks[0]).toContain('## Task Management');
    expect(appendSkillInstructions('BASE', r.instructionBlocks)).toContain('BASE\n\n## Task Management');
  });

  it('does not flatten per-tool action_risk when expanding calendar', () => {
    const tools = new ToolRegistry();
    tools.register(toolManifest('calendar-list-events', 'none'), noopHandler);
    tools.register(toolManifest('calendar-create-event', 'high'), noopHandler);

    const skills = new SkillRegistry();
    skills.register({
      name: 'calendar',
      description: 'calendar',
      tools: ['calendar-list-events', 'calendar-create-event'],
      instructions: '',
    }, '/tmp/calendar');

    resolvePinnedSkills(['calendar'], skills, tools);
    expect(tools.get('calendar-list-events')!.manifest.action_risk).toBe('none');
    expect(tools.get('calendar-create-event')!.manifest.action_risk).toBe('high');
  });

  it('falls back to a tool name when no skill matches (transitional)', () => {
    const tools = new ToolRegistry();
    tools.register(toolManifest('web-fetch'), noopHandler);
    const skills = new SkillRegistry();
    const r = resolvePinnedSkills(['web-fetch'], skills, tools);
    expect(r.toolNames).toEqual(['web-fetch']);
    expect(r.heartbeatEligible).toBe(false);
  });
});

describe('registerSyntheticSingletonSkills', () => {
  it('wraps orphan tools but not tools owned by a real skill', () => {
    const tools = new ToolRegistry();
    tools.register(toolManifest('web-fetch'), noopHandler);
    tools.register(toolManifest('calendar-list-events', 'none'), noopHandler);

    const skills = new SkillRegistry();
    skills.register({
      name: 'calendar',
      description: 'calendar',
      tools: ['calendar-list-events'],
      instructions: '',
    }, '/tmp/calendar');

    registerSyntheticSingletonSkills(tools, skills);
    expect(skills.get('web-fetch')?.synthetic).toBe(true);
    expect(skills.get('calendar-list-events')).toBeUndefined();
    expect(skills.toolOwner('calendar-list-events')?.manifest.name).toBe('calendar');
  });
});
