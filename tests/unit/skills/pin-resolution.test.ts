import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/skill-md.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { resolvePinnedSkills, appendSkillInstructions } from '../../../src/skills/pin-resolution.js';
import { registerSyntheticSingletonSkills } from '../../../src/skills/skill-loader.js';
import type { ToolManifest } from '../../../src/skills/types.js';

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

const TASK_TOOLS = ['task-create', 'task-list', 'task-update', 'task-complete'] as const;
const DOC_TOOLS = ['doc-read', 'doc-list', 'doc-write', 'doc-search'] as const;

describe('parseSkillMd', () => {
  it('parses Anthropic-compatible frontmatter + body', () => {
    const parsed = parseSkillMd(`---
name: tasks
description: Track work with tasks.
version: "0.1.0"
heartbeat: true
tools:
  - task-create
  - task-list
---

## Task Management

Do the work.
`);
    expect(parsed.name).toBe('tasks');
    expect(parsed.heartbeat).toBe(true);
    expect(parsed.tools).toEqual(['task-create', 'task-list']);
    expect(parsed.instructions).toContain('## Task Management');
  });

  it('rejects missing name', () => {
    expect(() => parseSkillMd('---\ndescription: x\n---\n')).toThrow(/name/);
  });
});

describe('on-disk skills/tasks + skills/documents', () => {
  it('tasks SKILL.md declares heartbeat and task tools', () => {
    const raw = readFileSync(resolve(import.meta.dirname, '../../../skills/tasks/SKILL.md'), 'utf-8');
    const parsed = parseSkillMd(raw);
    expect(parsed.name).toBe('tasks');
    expect(parsed.heartbeat).toBe(true);
    expect(parsed.document_workspace).toBeUndefined();
    expect(parsed.tools).toEqual([...TASK_TOOLS]);
    expect(parsed.instructions).toContain('## Task Management');
  });

  it('documents SKILL.md declares document_workspace and doc tools', () => {
    const raw = readFileSync(resolve(import.meta.dirname, '../../../skills/documents/SKILL.md'), 'utf-8');
    const parsed = parseSkillMd(raw);
    expect(parsed.name).toBe('documents');
    expect(parsed.document_workspace).toBe(true);
    expect(parsed.heartbeat).toBeUndefined();
    expect(parsed.tools).toEqual([...DOC_TOOLS]);
    expect(parsed.instructions).toContain('## Document Workspace');
  });
});

describe('resolvePinnedSkills', () => {
  it('expands tasks + documents independently and ORs flags', () => {
    const tools = new ToolRegistry();
    for (const name of [...TASK_TOOLS, ...DOC_TOOLS]) {
      tools.register(toolManifest(name, name.startsWith('task') ? 'low' : 'none'), noopHandler);
    }

    const skills = new SkillRegistry();
    const tasksMd = parseSkillMd(
      readFileSync(resolve(import.meta.dirname, '../../../skills/tasks/SKILL.md'), 'utf-8'),
    );
    const docsMd = parseSkillMd(
      readFileSync(resolve(import.meta.dirname, '../../../skills/documents/SKILL.md'), 'utf-8'),
    );
    skills.register({
      name: tasksMd.name,
      description: tasksMd.description,
      version: tasksMd.version,
      tools: tasksMd.tools ?? [],
      instructions: tasksMd.instructions,
      heartbeat: tasksMd.heartbeat,
      document_workspace: tasksMd.document_workspace,
    }, '/tmp/tasks');
    skills.register({
      name: docsMd.name,
      description: docsMd.description,
      version: docsMd.version,
      tools: docsMd.tools ?? [],
      instructions: docsMd.instructions,
      heartbeat: docsMd.heartbeat,
      document_workspace: docsMd.document_workspace,
    }, '/tmp/documents');

    const r = resolvePinnedSkills(['tasks', 'documents'], skills, tools);
    expect(r.toolNames).toEqual([...TASK_TOOLS, ...DOC_TOOLS]);
    expect(r.heartbeatEligible).toBe(true);
    expect(r.documentWorkspaceEnabled).toBe(true);
    expect(r.instructionBlocks).toHaveLength(2);
    const prompt = appendSkillInstructions('BASE', r.instructionBlocks);
    expect(prompt).toContain('## Task Management');
    expect(prompt).toContain('## Document Workspace');
  });

  it('wires heartbeat without documents when only tasks is pinned', () => {
    const tools = new ToolRegistry();
    for (const name of TASK_TOOLS) {
      tools.register(toolManifest(name, 'low'), noopHandler);
    }
    const skills = new SkillRegistry();
    skills.register({
      name: 'tasks',
      description: 'tasks',
      tools: [...TASK_TOOLS],
      instructions: '## Task Management\n\nDo it.',
      heartbeat: true,
    }, '/tmp/tasks');

    const r = resolvePinnedSkills(['tasks'], skills, tools);
    expect(r.heartbeatEligible).toBe(true);
    expect(r.documentWorkspaceEnabled).toBe(false);
    expect(r.toolNames).toEqual([...TASK_TOOLS]);
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

  it('skips expanded tools that are not loaded', () => {
    const tools = new ToolRegistry();
    tools.register(toolManifest('calendar-list-events', 'none'), noopHandler);
    // calendar-create-event deliberately not registered
    const skills = new SkillRegistry();
    skills.register({
      name: 'calendar',
      description: 'calendar',
      tools: ['calendar-list-events', 'calendar-create-event'],
      instructions: '',
    }, '/tmp/calendar');

    const r = resolvePinnedSkills(['calendar'], skills, tools);
    expect(r.toolNames).toEqual(['calendar-list-events']);
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
