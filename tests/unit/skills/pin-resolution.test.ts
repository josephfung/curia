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

const TASK_TOOLS = [
  'task-create',
  'task-list',
  'task-update',
  'task-complete',
  'plan',
  'checkpoint',
] as const;
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

  it('rejects non-boolean heartbeat / document_workspace', () => {
    expect(() => parseSkillMd('---\nname: x\ndescription: y\nheartbeat: "true"\n---\n')).toThrow(/heartbeat/);
    expect(() => parseSkillMd('---\nname: x\ndescription: y\ndocument_workspace: 1\n---\n')).toThrow(/document_workspace/);
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

  it('resolves a first-class tool pin when no skill name matches (ADR-032)', () => {
    const tools = new ToolRegistry();
    tools.register(toolManifest('web-fetch'), noopHandler);
    const skills = new SkillRegistry();
    const r = resolvePinnedSkills(['web-fetch'], skills, tools);
    expect(r.toolNames).toEqual(['web-fetch']);
    expect(r.heartbeatEligible).toBe(false);
    expect(r.resolvedPins).toEqual([{ pin: 'web-fetch', kind: 'tool' }]);
  });

  it('pinning one tool of a bundle does not resolve sibling tools (ADR-032)', () => {
    const tools = new ToolRegistry();
    tools.register(toolManifest('ceo-inbox-search', 'none'), noopHandler);
    tools.register(toolManifest('ceo-inbox-download-attachment', 'none'), noopHandler);
    tools.register(toolManifest('ceo-inbox-draft-compose', 'medium'), noopHandler);
    tools.register(toolManifest('ceo-inbox-archive', 'low'), noopHandler);

    const skills = new SkillRegistry();
    skills.register(
      {
        name: 'ceo-inbox',
        description: 'CEO inbox',
        tools: [
          'ceo-inbox-search',
          'ceo-inbox-download-attachment',
          'ceo-inbox-draft-compose',
          'ceo-inbox-archive',
        ],
        instructions: '## CEO Inbox\n\nTriage carefully.',
      },
      '/tmp/ceo-inbox',
    );

    // Direct tool pins — must not expand the owning bundle.
    const r = resolvePinnedSkills(
      ['ceo-inbox-search', 'ceo-inbox-download-attachment'],
      skills,
      tools,
    );
    expect(r.toolNames).toEqual(['ceo-inbox-search', 'ceo-inbox-download-attachment']);
    expect(r.instructionBlocks).toHaveLength(0);
    expect(r.resolvedSkills).toEqual([]);
    expect(r.resolvedPins).toEqual([
      { pin: 'ceo-inbox-search', kind: 'tool' },
      { pin: 'ceo-inbox-download-attachment', kind: 'tool' },
    ]);
  });

  it('pinning an MCP-projected skill expands its live tool set (ADR-032)', () => {
    const tools = new ToolRegistry();
    tools.register(toolManifest('create_doc', 'low'), noopHandler);
    tools.register(toolManifest('search_drive_files', 'low'), noopHandler);
    const skills = new SkillRegistry();
    skills.register(
      {
        name: 'google-workspace',
        description: 'MCP server google-workspace',
        tools: ['create_doc', 'search_drive_files'],
        instructions: '',
      },
      '',
    );

    const r = resolvePinnedSkills(['google-workspace'], skills, tools);
    expect(r.toolNames).toEqual(['create_doc', 'search_drive_files']);
    expect(r.resolvedSkills).toEqual(['google-workspace']);
    expect(r.resolvedPins).toEqual([{ pin: 'google-workspace', kind: 'skill' }]);
  });

  it('preserves mixed per-tool action_risk through the contacts bundle', () => {
    const tools = new ToolRegistry();
    tools.register(toolManifest('contact-lookup', 'none'), noopHandler);
    tools.register(toolManifest('contact-grant-permission', 'critical'), noopHandler);
    const skills = new SkillRegistry();
    skills.register(
      {
        name: 'contacts',
        description: 'contacts',
        tools: ['contact-lookup', 'contact-grant-permission'],
        instructions: '',
      },
      '/tmp/contacts',
    );

    resolvePinnedSkills(['contacts'], skills, tools);
    expect(tools.get('contact-lookup')!.manifest.action_risk).toBe('none');
    expect(tools.get('contact-grant-permission')!.manifest.action_risk).toBe('critical');
  });
});

describe('on-disk contacts bundle guards', () => {
  it('does not list entity-context as a contacts member', () => {
    const raw = readFileSync(
      resolve(import.meta.dirname, '../../../skills/contacts/SKILL.md'),
      'utf-8',
    );
    const parsed = parseSkillMd(raw);
    expect(parsed.tools).not.toContain('entity-context');
    expect(parsed.tools).toEqual(expect.arrayContaining(['contact-lookup', 'contact-grant-permission']));
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
