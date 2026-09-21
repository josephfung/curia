// Structural contract: coordinator routes principal calendar to @calendar (#1853).
// Asserted at the tool-selection / config layer — no LLM. Verifies routing text,
// pinned_skills stay free of principal calendar tools, and google-workspace MCP
// calendar tools cannot land in the coordinator's resolved toolset.

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
  filterHeldBackMcpTools,
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

describe('coordinator principal-calendar routing (#1853)', () => {
  it('has an explicit CEO calendar → @calendar borrow-then-answer rule', () => {
    const prompt = loadCoordinator().system_prompt;
    expect(prompt).toContain('### CEO calendar requests (borrow-then-answer)');
    expect(prompt).toMatch(/delegated to `@calendar`/);
    expect(prompt).toMatch(/never\s+read or mutate the CEO's calendar myself/i);
  });

  it('narrows handle-directly so calendar means Curia only, not the CEO', () => {
    const prompt = loadCoordinator().system_prompt;
    const handleDirectly = prompt.slice(
      prompt.indexOf('1. **Handle directly**'),
      prompt.indexOf('2. **Borrow-then-answer**'),
    );
    expect(handleDirectly).toMatch(/never the CEO's/i);
    expect(handleDirectly).toMatch(/@calendar/);
    expect(handleDirectly).not.toMatch(/my own email\/calendar\/workspace/);
  });

  it('does not pin principal-scoped calendar tools or the calendar bundle', () => {
    const pins = loadCoordinator().pinned_skills ?? [];
    expect(pins).toContain('google-workspace');
    expect(pins).not.toContain('calendar');
    expect(pins).not.toContain('calendar-list-events');
    expect(pins).not.toContain('calendar-check-conflicts');
    expect(pins).not.toContain('get_events');
    expect(pins).not.toContain('list_calendars');
    expect(pins).not.toContain('query_freebusy');
  });

  it('resolved toolset excludes google-workspace calendar tools (tool-selection layer)', () => {
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
      // Held-back tools: present in ToolRegistry only if registration skipped filtering —
      // we deliberately do NOT register them here, matching production after #1853.
      ...GOOGLE_WORKSPACE_CALENDAR_TOOLS_HELD_BACK,
    ]) {
      needed.add(extra);
    }
    for (const name of needed) {
      if (
        (GOOGLE_WORKSPACE_CALENDAR_TOOLS_HELD_BACK as readonly string[]).includes(name)
      ) {
        continue; // not registered — same as MCP holdback
      }
      if (!tools.get(name)) tools.register(toolManifest(name), noopHandler);
    }

    const liveMembership = filterHeldBackMcpTools('google-workspace', [
      'create_doc',
      'search_drive_files',
      ...GOOGLE_WORKSPACE_CALENDAR_TOOLS_HELD_BACK,
    ]);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    registerMcpProjectedSkills(
      new Map([['google-workspace', liveMembership]]),
      skills,
      logger,
    );
    registerSyntheticSingletonSkills(tools, skills);

    const resolved = resolvePinnedSkills(
      config.pinned_skills ?? [],
      skills,
      tools,
    ).toolNames;

    for (const heldBack of GOOGLE_WORKSPACE_CALENDAR_TOOLS_HELD_BACK) {
      expect(resolved).not.toContain(heldBack);
    }
    expect(resolved).not.toContain('calendar-list-events');
    expect(resolved).toContain('delegate');
    expect(resolved).toContain('create_doc');
  });
});
