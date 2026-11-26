import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/skill-md.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { resolvePinnedSkills, appendSkillInstructions, reportScheduledPinGaps, reportWithheldPinTools, collectPinnedByBundle } from '../../../src/skills/pin-resolution.js';
import { registerSyntheticSingletonSkills } from '../../../src/skills/skill-loader.js';
import { discoverToolManifests } from '../../../src/skills/loader.js';
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
const DOC_TOOLS = ['doc-read', 'doc-list', 'doc-write', 'doc-search', 'doc-place'] as const;

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
    expect(parsed.instructions).toContain('task-complete');
  });

  // Prompt trim PR 9: text only a wake needs rides on the wake, not in the SKILL.md every
  // turn reads. Each row names where the rule now lives.
  it.each([
    ['tasks', 'does not close the task', 'WAKE_DISPOSITION_INSTRUCTION (src/scheduler/wake-disposition.ts)'],
    ['tasks', 'Pick up where', 'WAKE_DISPOSITION_INSTRUCTION'],
    ['tasks', 'past at creation', "task-create's seeded progress note and task-complete's refusal (#1299)"],
    ['documents', 'ttl_days', "doc-write's description"],
    ['documents', 'collision_short_id', 'the Projects Catalog block injected on task wakes'],
    ['documents', 'On resume', 'the Workspace Manifest block injected on task wakes'],
  ])('%s SKILL.md does not restate "%s" (lives in %s)', (skill, phrase) => {
    const raw = readFileSync(resolve(import.meta.dirname, `../../../skills/${skill}/SKILL.md`), 'utf-8');
    expect(parseSkillMd(raw).instructions).not.toContain(phrase);
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
    expect(r.listedSkills).toEqual([]);
    const prompt = appendSkillInstructions('BASE', r.instructionBlocks);
    expect(prompt).toContain('## Task Management');
    expect(prompt).toContain('## Document Workspace');
  });

  it('on_demand lists skills without expanding tools or bodies (#2764)', () => {
    const tools = new ToolRegistry();
    for (const name of [...TASK_TOOLS, ...DOC_TOOLS]) {
      tools.register(toolManifest(name, 'low'), noopHandler);
    }
    const skills = new SkillRegistry();
    skills.register({
      name: 'tasks',
      description: 'Track work that outlasts this turn.',
      tools: [...TASK_TOOLS],
      instructions: '## Task Management\n\nDo it.',
      heartbeat: true,
    }, '/tmp/tasks');
    skills.register({
      name: 'documents',
      description: 'Read and write workspace documents.',
      tools: [...DOC_TOOLS],
      instructions: '## Document Workspace\n\nWrite it.',
      document_workspace: true,
    }, '/tmp/documents');

    const r = resolvePinnedSkills(
      ['tasks', 'documents'],
      skills,
      tools,
      undefined,
      'coordinator',
      'on_demand',
    );
    expect(r.toolNames).toEqual([]);
    expect(r.instructionBlocks).toEqual([]);
    expect(r.listedSkills).toEqual([
      { name: 'tasks', description: 'Track work that outlasts this turn.' },
      { name: 'documents', description: 'Read and write workspace documents.' },
    ]);
    expect(r.heartbeatEligible).toBe(true);
    expect(r.documentWorkspaceEnabled).toBe(true);
    expect(r.resolvedSkills).toEqual(['tasks', 'documents']);
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

  it('does not offer a system-only member tool through a bundle pin (#1358)', () => {
    const tools = new ToolRegistry();
    tools.register(toolManifest('card-use-request', 'low'), noopHandler);
    tools.register({ ...toolManifest('card-use-confirm', 'critical'), allowed_callers: ['system'] }, noopHandler);
    const skills = new SkillRegistry();
    skills.register({
      name: 'web',
      description: 'web',
      tools: ['card-use-request', 'card-use-confirm'],
      instructions: '',
    }, '/tmp/web');

    const r = resolvePinnedSkills(['web'], skills, tools);
    expect(r.toolNames).toEqual(['card-use-request']);
    expect(r.unresolvedPins).toEqual([]);
  });

  describe('allowed_callers (#2646)', () => {
    function calendarFixture(
      members: string[] = ['calendar-list-events', 'calendar-open-tool'],
      instructions = '',
    ) {
      const tools = new ToolRegistry();
      tools.register(
        { ...toolManifest('calendar-list-events'), allowed_callers: ['calendar', 'meeting-debrief', 'contacts'] },
        noopHandler,
      );
      tools.register(toolManifest('calendar-open-tool'), noopHandler);
      const skills = new SkillRegistry();
      skills.register({
        name: 'calendar',
        description: 'calendar',
        tools: members,
        instructions,
      }, '/tmp/calendar');
      return { tools, skills };
    }

    it('does not hand an agent a bundle member its allowed_callers excludes', () => {
      const { tools, skills } = calendarFixture();
      const r = resolvePinnedSkills(['calendar'], skills, tools, undefined, 'social-media');
      expect(r.toolNames).toEqual(['calendar-open-tool']);
      expect(r.unresolvedPins).toEqual([
        { pin: 'calendar', reason: 'caller_not_allowed', withheldTools: ['calendar-list-events'] },
      ]);
    });

    it('still hands the tool to an agent that allowed_callers names', () => {
      const { tools, skills } = calendarFixture();
      const r = resolvePinnedSkills(['calendar'], skills, tools, undefined, 'calendar');
      expect(r.toolNames).toEqual(['calendar-list-events', 'calendar-open-tool']);
      expect(r.unresolvedPins).toEqual([]);
    });

    it('does not resolve a bundle whose every member is withheld, nor splice in its owner\'s instructions', () => {
      const { tools, skills } = calendarFixture(['calendar-list-events'], 'Owner-only calendar playbook');
      const r = resolvePinnedSkills(['calendar'], skills, tools, undefined, 'social-media');
      expect(r.toolNames).toEqual([]);
      expect(r.instructionBlocks).toEqual([]);
      expect(r.instructionBlockSkills).toEqual([]);
      expect(r.resolvedSkills).toEqual([]);
      expect(r.resolvedPins).toEqual([]);
      expect(r.unresolvedPins).toEqual([
        { pin: 'calendar', reason: 'caller_not_allowed', withheldTools: ['calendar-list-events'] },
      ]);
    });

    it('records a gap when a bundle holds only system-only tools, instead of dropping it silently', () => {
      const tools = new ToolRegistry();
      tools.register({ ...toolManifest('infra-sweep'), allowed_callers: ['system'] }, noopHandler);
      const skills = new SkillRegistry();
      skills.register({
        name: 'infra',
        description: 'infra',
        tools: ['infra-sweep'],
        instructions: 'Infra playbook',
      }, '/tmp/infra');
      const r = resolvePinnedSkills(['infra'], skills, tools, undefined, 'social-media');
      expect(r.toolNames).toEqual([]);
      expect(r.instructionBlocks).toEqual([]);
      expect(r.resolvedSkills).toEqual([]);
      expect(r.unresolvedPins).toEqual([
        { pin: 'infra', reason: 'caller_not_allowed', withheldTools: ['infra-sweep'] },
      ]);
    });

    it('keeps the instructions of a bundle the agent can still use in part', () => {
      const { tools, skills } = calendarFixture(['calendar-list-events', 'calendar-open-tool'], 'Shared calendar notes');
      const r = resolvePinnedSkills(['calendar'], skills, tools, undefined, 'social-media');
      expect(r.instructionBlocks).toEqual(['Shared calendar notes']);
      expect(r.resolvedSkills).toEqual(['calendar']);
    });

    it('skips a direct tool pin the agent may not call and reports it with a distinct reason', () => {
      const { tools, skills } = calendarFixture();
      const r = resolvePinnedSkills(['calendar-list-events'], skills, tools, undefined, 'social-media');
      expect(r.toolNames).toEqual([]);
      expect(r.resolvedPins).toEqual([]);
      expect(r.unresolvedPins).toEqual([
        { pin: 'calendar-list-events', reason: 'caller_not_allowed', withheldTools: ['calendar-list-events'] },
      ]);
    });

    it('reports missing and withheld members as separate entries when a bundle has both', () => {
      const { tools, skills } = calendarFixture(['calendar-list-events', 'calendar-open-tool', 'calendar-not-loaded']);
      const r = resolvePinnedSkills(['calendar'], skills, tools, undefined, 'social-media');
      expect(r.unresolvedPins).toEqual([
        { pin: 'calendar', reason: 'member_tools_missing', missingTools: ['calendar-not-loaded'] },
        { pin: 'calendar', reason: 'caller_not_allowed', withheldTools: ['calendar-list-events'] },
      ]);
    });
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
    expect(r.unresolvedPins).toEqual([
      {
        pin: 'calendar',
        reason: 'member_tools_missing',
        missingTools: ['calendar-create-event'],
      },
    ]);
  });

  it('records not_found for pins absent from both registries', () => {
    const tools = new ToolRegistry();
    const skills = new SkillRegistry();
    const r = resolvePinnedSkills(['google-workspace', 'web-fetch'], skills, tools);
    expect(r.toolNames).toEqual([]);
    expect(r.resolvedPins).toEqual([]);
    expect(r.unresolvedPins).toEqual([
      { pin: 'google-workspace', reason: 'not_found' },
      { pin: 'web-fetch', reason: 'not_found' },
    ]);
  });

  it('returns empty unresolvedPins when every pin resolves', () => {
    const tools = new ToolRegistry();
    tools.register(toolManifest('web-fetch'), noopHandler);
    const skills = new SkillRegistry();
    const r = resolvePinnedSkills(['web-fetch'], skills, tools);
    expect(r.unresolvedPins).toEqual([]);
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

describe('reportScheduledPinGaps (#1501)', () => {
  function emptyResolution(overrides: Partial<ReturnType<typeof resolvePinnedSkills>> = {}) {
    return {
      toolNames: [],
      instructionBlocks: [],
      instructionBlockSkills: [],
      listedSkills: [],
      heartbeatEligible: false,
      documentWorkspaceEnabled: false,
      resolvedSkills: [],
      resolvedPins: [] as Array<{ pin: string; kind: 'skill' | 'tool' }>,
      unresolvedPins: [] as Array<{ pin: string; reason: 'not_found' | 'member_tools_missing'; missingTools?: string[] }>,
      ...overrides,
    };
  }

  it('logs error when a scheduled agent has unresolved pins (schedules still allowed)', () => {
    const errors: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
    const logger = {
      error: (ctx: Record<string, unknown>, msg: string) => {
        errors.push({ msg, ctx });
      },
      warn: () => {},
      info: () => {},
      debug: () => {},
    } as unknown as import('../../../src/logger.js').Logger;

    const tools = new ToolRegistry();
    const skills = new SkillRegistry();
    const resolution = resolvePinnedSkills(
      ['google-workspace', 'tasks'],
      skills,
      tools,
      logger,
      'T2125-expense-tracker',
    );
    reportScheduledPinGaps('T2125-expense-tracker', resolution, true, logger);

    expect(resolution.unresolvedPins.map((g) => g.pin)).toEqual([
      'google-workspace',
      'tasks',
    ]);
    expect(errors.some((e) => e.msg.includes('unresolved pinned skills'))).toBe(true);
    expect(errors.some((e) => e.msg.includes('Refusing'))).toBe(false);
  });

  it('does not escalate when the agent has no schedule', () => {
    const errors: string[] = [];
    const logger = {
      error: (_ctx: Record<string, unknown>, msg: string) => {
        errors.push(msg);
      },
      warn: () => {},
      info: () => {},
      debug: () => {},
    } as unknown as import('../../../src/logger.js').Logger;

    const resolution = emptyResolution({
      unresolvedPins: [{ pin: 'optional-mcp', reason: 'not_found' }],
    });
    reportScheduledPinGaps('research-analyst', resolution, false, logger);
    expect(errors).toHaveLength(0);
  });

  it('does not escalate when every pin resolved', () => {
    const errors: string[] = [];
    const logger = {
      error: (_ctx: Record<string, unknown>, msg: string) => {
        errors.push(msg);
      },
      warn: () => {},
      info: () => {},
      debug: () => {},
    } as unknown as import('../../../src/logger.js').Logger;

    reportScheduledPinGaps('ceo-inbox', emptyResolution(), true, logger);
    expect(errors).toHaveLength(0);
  });
});

describe('reportWithheldPinTools (#2646)', () => {
  function captureLogger() {
    const warns: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
    const errors: string[] = [];
    const logger = {
      error: (_ctx: Record<string, unknown>, msg: string) => { errors.push(msg); },
      warn: (ctx: Record<string, unknown>, msg: string) => { warns.push({ msg, ctx }); },
      info: () => {},
      debug: () => {},
    } as unknown as import('../../../src/logger.js').Logger;
    return { logger, warns, errors };
  }

  function resolutionWith(unresolvedPins: ReturnType<typeof resolvePinnedSkills>['unresolvedPins']) {
    return {
      toolNames: [],
      instructionBlocks: [],
      instructionBlockSkills: [],
      listedSkills: [],
      heartbeatEligible: false,
      documentWorkspaceEnabled: false,
      resolvedSkills: [],
      resolvedPins: [],
      unresolvedPins,
    };
  }

  it('logs one warn per agent naming the agent and every withheld tool', () => {
    const { logger, warns } = captureLogger();
    reportWithheldPinTools('social-media', resolutionWith([
      { pin: 'calendar', reason: 'caller_not_allowed', withheldTools: ['calendar-list-events', 'calendar-find-slot'] },
      { pin: 'calendar-get-event', reason: 'caller_not_allowed', withheldTools: ['calendar-get-event'] },
    ]), logger);

    expect(warns).toHaveLength(1);
    expect(warns[0]!.ctx.agent).toBe('social-media');
    expect(warns[0]!.ctx.withheldTools).toEqual([
      { pin: 'calendar', tools: ['calendar-list-events', 'calendar-find-slot'] },
      { pin: 'calendar-get-event', tools: ['calendar-get-event'] },
    ]);
  });

  it('stays quiet when nothing was withheld', () => {
    const { logger, warns } = captureLogger();
    reportWithheldPinTools('ceo-inbox', resolutionWith([{ pin: 'x', reason: 'not_found' }]), logger);
    expect(warns).toHaveLength(0);
  });

  it('does not make a scheduled agent error when a pin lost only some tools', () => {
    const { logger, errors } = captureLogger();
    reportScheduledPinGaps('social-media', {
      ...resolutionWith([
        { pin: 'calendar', reason: 'caller_not_allowed', withheldTools: ['calendar-list-events'] },
      ]),
      resolvedPins: [{ pin: 'calendar', kind: 'skill' }],
    }, true, logger);
    expect(errors).toHaveLength(0);
  });

  it('errors for a scheduled agent that lost a whole pin to allowed_callers', () => {
    const { logger, errors } = captureLogger();
    reportScheduledPinGaps('social-media', resolutionWith([
      { pin: 'calendar', reason: 'caller_not_allowed', withheldTools: ['calendar-list-events'] },
    ]), true, logger);
    expect(errors).toHaveLength(1);
  });
});

describe('collectPinnedByBundle (#1898)', () => {
  it('reports an agent whose config failed to parse instead of omitting its pins silently', () => {
    const errors: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
    const logger = {
      error: (ctx: Record<string, unknown>, msg: string) => {
        errors.push({ msg, ctx });
      },
      warn: () => {},
      info: () => {},
      debug: () => {},
    } as unknown as import('../../../src/logger.js').Logger;

    const pinned = collectPinnedByBundle([
      { name: 'ceo-inbox', pinnedSkills: ['email'] },
      { name: 'broken-agent', pinnedSkills: null, parseError: 'bad yaml' },
      { name: 'quiet', pinnedSkills: [] },
    ], logger);

    expect(pinned.get('email')).toEqual(['ceo-inbox']);
    expect([...pinned.keys()]).toEqual(['email']);
    expect(errors).toEqual([
      {
        msg: 'Pin-gap detection: agent config failed to parse — skill pins are unknown and this agent is omitted from pinnedByBundle',
        ctx: { agent: 'broken-agent', parseError: 'bad yaml' },
      },
    ]);
  });
});

describe('on-disk contacts bundle guards', () => {
  it('keeps everyday identity tools and leaves grants in contact-trust (#2764)', () => {
    const contacts = parseSkillMd(
      readFileSync(resolve(import.meta.dirname, '../../../skills/contacts/SKILL.md'), 'utf-8'),
    );
    const trust = parseSkillMd(
      readFileSync(resolve(import.meta.dirname, '../../../skills/contact-trust/SKILL.md'), 'utf-8'),
    );
    expect(contacts.tools).not.toContain('entity-context');
    expect(contacts.tools).not.toContain('contact-grant-permission');
    expect(contacts.tools).toEqual(
      expect.arrayContaining(['contact-lookup', 'contact-create', 'contact-list']),
    );
    expect(trust.tools).toEqual(expect.arrayContaining(['contact-grant-permission']));
  });
});

describe('on-disk bullpen bundle (#2126)', () => {
  const skillsDir = resolve(import.meta.dirname, '../../../skills');
  const parsed = parseSkillMd(readFileSync(resolve(skillsDir, 'bullpen/SKILL.md'), 'utf-8'));
  const tools = new ToolRegistry();
  for (const disc of discoverToolManifests(skillsDir)) {
    if (disc.manifest && disc.manifest.name.startsWith('bullpen')) tools.register(disc.manifest, noopHandler);
  }
  const skills = new SkillRegistry();
  skills.register(
    { name: parsed.name, description: parsed.description, tools: parsed.tools ?? [], instructions: parsed.instructions },
    resolve(skillsDir, 'bullpen'),
  );
  registerSyntheticSingletonSkills(tools, skills);

  it('has no SKILL.md body, so the bundle adds nothing to the always-on prompt', () => {
    expect(parsed.instructions).toBe('');
  });

  it('resolves an existing `- bullpen` pin to the four tools, and nothing named bullpen', () => {
    const resolution = resolvePinnedSkills(['bullpen'], skills, tools);
    expect(resolution.unresolvedPins).toEqual([]);
    expect([...resolution.toolNames].sort()).toEqual(['bullpen-close', 'bullpen-post', 'bullpen-read', 'bullpen-reply']);
    expect(tools.get('bullpen')).toBeUndefined();
  });

  it('marks each tool\'s own fields required, so a reply requires content', () => {
    const required = Object.fromEntries(
      tools.toToolDefinitions(['bullpen-post', 'bullpen-reply', 'bullpen-read', 'bullpen-close'])
        .map(def => [def.name, [...(def.input_schema.required ?? [])].sort()]),
    );
    expect(required).toEqual({
      'bullpen-post': ['content', 'participants', 'topic'],
      'bullpen-reply': ['content', 'thread_id'],
      'bullpen-read': ['thread_id'],
      'bullpen-close': ['thread_id'],
    });
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
