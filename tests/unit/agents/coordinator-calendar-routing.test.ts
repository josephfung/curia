// Structural contract: coordinator routes principal calendar to @calendar (#1853).
// Asserted at the tool-selection / config layer — no LLM.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAgentConfig } from '../../../src/agents/loader.js';
import { parseSkillMd } from '../../../src/skills/skill-md.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { resolvePinnedSkills } from '../../../src/skills/pin-resolution.js';
import { registerSyntheticSingletonSkills } from '../../../src/skills/skill-loader.js';
import {
  GOOGLE_WORKSPACE_CALENDAR_TOOLS_HELD_BACK,
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

function extractCeoCalendarSection(prompt: string): string {
  const start = prompt.indexOf('### CEO calendar requests (borrow-then-answer)');
  const end = prompt.indexOf('### Delegation acknowledgment on synchronous channels');
  if (start === -1) throw new Error('CEO calendar requests section not found');
  if (end === -1 || end <= start) {
    throw new Error('Delegation acknowledgment delimiter not found after CEO calendar section');
  }
  return prompt.slice(start, end);
}

describe('coordinator principal-calendar routing (#1853)', () => {
  it('has an explicit CEO calendar → @calendar borrow-then-answer rule', () => {
    const section = extractCeoCalendarSection(loadCoordinator().system_prompt);
    expect(section).toMatch(/delegated to `@calendar`/);
    expect(section).toMatch(/never\s+read or mutate the CEO's calendar myself/i);
    expect(section).toMatch(/never present the brief/i);
    expect(section).toMatch(/could not be read/i);
    expect(section).toMatch(/do not search\s+tool-registry/i);
  });

  it('drops calendar from handle-directly (no Curia calendar path)', () => {
    const handleDirectly = extractHandleDirectlySection(loadCoordinator().system_prompt);
    expect(handleDirectly).toMatch(/Calendar is never handle-directly/i);
    expect(handleDirectly).toMatch(/@calendar/);
    expect(handleDirectly).not.toMatch(/my own email\/calendar\/workspace/);
    expect(handleDirectly).not.toMatch(/Curia's identity only/);
  });

  it('does not pin principal-scoped calendar tools or the calendar bundle', () => {
    const pins = loadCoordinator().pinned_skills ?? [];
    expect(pins).toContain('google-workspace');
    expect(pins).not.toContain('calendar');
    expect(pins).not.toContain('calendar-list-events');
    expect(pins).not.toContain('calendar-check-conflicts');
    for (const heldBack of GOOGLE_WORKSPACE_CALENDAR_TOOLS_HELD_BACK) {
      expect(pins).not.toContain(heldBack);
    }
  });

  it('projected google-workspace membership leaves no unresolved calendar pins', () => {
    // Simulates post-holdback projection: ToolRegistry has Drive tools but not the
    // held-back calendar names. If projection still listed held-back members,
    // resolvePinnedSkills would record member_tools_missing and
    // reportScheduledPinGaps would error-log every coordinator boot.
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
      'approval-expiry-sweep',
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

    // Pass the RAW advertised set (including held-back names). registerMcpProjectedSkills
    // must filter them — that is what this assertion guards.
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
          ['create_doc', 'search_drive_files', ...GOOGLE_WORKSPACE_CALENDAR_TOOLS_HELD_BACK],
        ],
      ]),
      skills,
      logger,
    );
    registerSyntheticSingletonSkills(tools, skills);

    const resolution = resolvePinnedSkills(config.pinned_skills ?? [], skills, tools);
    expect(resolution.unresolvedPins).toEqual([]);
    for (const heldBack of GOOGLE_WORKSPACE_CALENDAR_TOOLS_HELD_BACK) {
      expect(resolution.toolNames).not.toContain(heldBack);
    }
    expect(resolution.toolNames).not.toContain('calendar-list-events');
    expect(resolution.toolNames).toContain('delegate');
    expect(resolution.toolNames).toContain('create_doc');
  });
});
