// Structural contract: coordinator routes principal calendar to @calendar (#1853).
// Asserted at the tool-selection / config layer — no LLM.

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAgentConfig } from '../../../src/agents/loader.js';
import { parseSkillMd } from '../../../src/skills/skill-md.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { resolvePinnedSkills } from '../../../src/skills/pin-resolution.js';
import { registerSyntheticSingletonSkills } from '../../../src/skills/skill-loader.js';
import { resolveSkillActivation, unifiedToolSearch } from '../../../src/skills/skill-activation.js';
import {
  GOOGLE_WORKSPACE_CALENDAR_TOOL_NAME,
  registerMcpProjectedSkills,
} from '../../../src/skills/mcp-loader.js';
import type { ToolManifest } from '../../../src/skills/types.js';
import type { Logger } from '../../../src/logger.js';

const agentsDir = resolve(import.meta.dirname, '../../../agents');
const skillsDir = resolve(import.meta.dirname, '../../../skills');

const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };

function toolManifest(name: string): ToolManifest {
  return {
    name,
    description: name,
    version: '0.1.0',
    action_risk: 'none',
    sensitivity: 'normal',
    permissions: [],
    secrets: [],
    timeout: 30000,
    inputs: {},
    outputs: {},
  };
}

function loadCoordinator() {
  return loadAgentConfig(resolve(agentsDir, 'coordinator.yaml'));
}

function extractHandleDirectlySection(prompt: string): string {
  const start = prompt.indexOf('1. **Handle directly**');
  const end = prompt.indexOf('2. **Borrow-then-answer**');
  if (start === -1) throw new Error('Handle directly section not found');
  if (end === -1 || end <= start) {
    throw new Error('Borrow-then-answer delimiter not found after Handle directly');
  }
  return prompt.slice(start, end);
}

function extractPrincipalCalendarSection(prompt: string): string {
  const start = prompt.indexOf('### Principal calendar requests (borrow-then-answer)');
  const end = prompt.indexOf('### Delegation acknowledgment on synchronous channels');
  if (start === -1) throw new Error('Principal calendar requests section not found');
  if (end === -1 || end <= start) {
    throw new Error('Delegation acknowledgment delimiter not found after Principal calendar section');
  }
  return prompt.slice(start, end);
}

describe('coordinator principal-calendar routing (#1853)', () => {
  it('has the prompt-only parts of the principal-calendar rule: the route and the failure line', () => {
    // "I never read or mutate the principal's calendar myself" is gone from the prompt
    // (prompt trim PR 2): allowed_callers enforces it, and the discovery and pin tests
    // below assert that. The route and the failure handling have no code home yet.
    const section = extractPrincipalCalendarSection(loadCoordinator().system_prompt);
    expect(section).toMatch(/borrow-then-answer through `@calendar`/);
    expect(section).toMatch(/could not be read/i);
  });

  it('handle-directly does not claim the calendar (no Curia calendar path)', () => {
    const handleDirectly = extractHandleDirectlySection(loadCoordinator().system_prompt);
    expect(handleDirectly).not.toMatch(/calendar/i);
    expect(handleDirectly).not.toMatch(/Curia's identity only/);
  });

  it('states the @calendar route only in the calendar section (#1958)', () => {
    // It was once repeated in nine places. Each copy is rule density with no added protection.
    const prompt = loadCoordinator().system_prompt;
    const outside = prompt.replace(extractPrincipalCalendarSection(prompt), '');
    expect(outside).not.toMatch(/@calendar/);
  });

  it('the coordinator can neither discover nor activate the calendar bundle (#1958)', () => {
    // This replaced a prompt sentence ("do not search tool-registry or skill-activate for
    // calendar"). The calendar tools exclude the coordinator by allowed_callers, and a
    // bundle every one of whose tools is withheld is neither offered by search nor
    // activatable (skillReservedForOtherAgents). Loaded from disk, so a calendar tool that
    // drops its allowed_callers, or a new tool under skills/calendar/tools the coordinator
    // may call, fails here. (A SKILL.md entry for a tool living elsewhere is not loaded.)
    const tools = new ToolRegistry();
    const skills = new SkillRegistry();
    const toolsDir = resolve(skillsDir, 'calendar', 'tools');
    for (const name of readdirSync(toolsDir)) {
      const manifest = JSON.parse(readFileSync(resolve(toolsDir, name, 'tool.json'), 'utf-8')) as ToolManifest;
      tools.register(manifest, noopHandler);
    }
    const parsed = parseSkillMd(readFileSync(resolve(skillsDir, 'calendar', 'SKILL.md'), 'utf-8'));
    skills.register(
      { name: parsed.name, description: parsed.description, version: parsed.version, tools: parsed.tools ?? [], instructions: parsed.instructions },
      resolve(skillsDir, 'calendar'),
    );

    for (const query of ['calendar', 'free time', 'calendar-list-events', 'events']) {
      const hits = unifiedToolSearch({ query, toolRegistry: tools, skillRegistry: skills, agentId: 'coordinator' });
      expect(hits, `search '${query}'`).toEqual([]);
    }
    expect(resolveSkillActivation({ skillName: 'calendar', skillRegistry: skills, toolRegistry: tools, agentId: 'coordinator' }))
      .toEqual({ error: expect.stringContaining('reserved for other agents') });
    // The owner is unaffected.
    expect(resolveSkillActivation({ skillName: 'calendar', skillRegistry: skills, toolRegistry: tools, agentId: 'calendar' }))
      .not.toHaveProperty('error');
  });

  it('does not pin principal-scoped calendar tools or the calendar bundle', () => {
    const pins = loadCoordinator().pinned_skills ?? [];
    expect(pins).not.toContain('calendar');
    expect(pins).not.toContain('calendar-list-events');
    expect(pins).not.toContain('calendar-check-conflicts');
    expect(pins.filter((p) => GOOGLE_WORKSPACE_CALENDAR_TOOL_NAME.test(p))).toEqual([]);
  });

  it('pins resolve cleanly, and activating google-workspace brings no calendar tools', () => {
    // The server's --tools allowlist (drive, docs, sheets) is the only gate on its
    // membership (#1957); projection passes the advertised set through unfiltered.
    // A clean resolution here means reportScheduledPinGaps stays quiet on boot. The
    // coordinator no longer pins google-workspace; it activates it on demand (#2024).
    const config = loadCoordinator();
    const tools = new ToolRegistry();
    const skills = new SkillRegistry();

    for (const name of [
      'calendar',
      'tasks',
      'documents',
      'email',
      'ceo-inbox',
      'contacts',
      'autonomy',
      'diagnostics',
      'scheduler',
      'web',
      'memory',
      'learning',
      'context-bridge',
      'executive-profile',
      'setup',
    ]) {
      const raw = readFileSync(resolve(skillsDir, name, 'SKILL.md'), 'utf-8');
      const parsed = parseSkillMd(raw);
      skills.register(
        {
          name: parsed.name,
          description: parsed.description,
          version: parsed.version,
          tools: parsed.tools ?? [],
          instructions: parsed.instructions,
          heartbeat: parsed.heartbeat,
          document_workspace: parsed.document_workspace,
        },
        resolve(skillsDir, name),
      );
    }

    const needed = new Set<string>();
    for (const s of skills.list()) {
      for (const t of s.manifest.tools) needed.add(t);
    }
    for (const pin of config.pinned_skills ?? []) needed.add(pin);
    for (const extra of [
      'entity-context',
      'config-store',
      'date-resolve',
      'bullpen',
      'delegate',
      'request-clarification',
      'file-parse',
      'tool-registry',
      'image-generate',
      'drive-download-file',
      'signal-send',
      'activity-log',
      'secret-capture-request',
      'list-user-secrets',
      'create_doc',
      'search_drive_files',
    ]) {
      needed.add(extra);
    }
    for (const name of needed) {
      if (!tools.get(name)) tools.register(toolManifest(name), noopHandler);
    }

    // What an allowlisted server advertises: Drive/Docs/Sheets tools only.
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    registerMcpProjectedSkills(
      new Map([
        [
          'google-workspace',
          ['create_doc', 'search_drive_files'],
        ],
      ]),
      skills,
      logger,
    );
    registerSyntheticSingletonSkills(tools, skills);

    const resolution = resolvePinnedSkills(config.pinned_skills ?? [], skills, tools);
    expect(resolution.unresolvedPins).toEqual([]);
    expect(resolution.toolNames.filter((t) => GOOGLE_WORKSPACE_CALENDAR_TOOL_NAME.test(t))).toEqual([]);
    expect(resolution.toolNames).not.toContain('calendar-list-events');
    expect(resolution.toolNames).toContain('delegate');
    expect(resolution.toolNames).not.toContain('create_doc');

    const activation = resolveSkillActivation({
      skillName: 'google-workspace', skillRegistry: skills, toolRegistry: tools, agentId: 'coordinator',
    });
    expect(activation).not.toHaveProperty('error');
    if (!('error' in activation)) {
      expect(activation.tools).toContain('create_doc');
      expect(activation.tools.filter((t) => GOOGLE_WORKSPACE_CALENDAR_TOOL_NAME.test(t))).toEqual([]);
    }
  });
});
