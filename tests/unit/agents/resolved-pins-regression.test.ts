// Regression: after #1494 bundling, each specialist's resolved member-tool set
// must match the pre-bundle authority (polymorphic pins prevent over-expansion).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAgentConfig } from '../../../src/agents/loader.js';
import { parseSkillMd } from '../../../src/skills/skill-md.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { resolvePinnedSkills } from '../../../src/skills/pin-resolution.js';
import { registerSyntheticSingletonSkills } from '../../../src/skills/skill-loader.js';
import type { ToolManifest } from '../../../src/skills/types.js';

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

function loadOnDiskSkills(registry: SkillRegistry): void {
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
    registry.register(
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
}

function resolveAgent(agentFile: string): string[] {
  const config = loadAgentConfig(resolve(agentsDir, agentFile));
  const tools = new ToolRegistry();
  const skills = new SkillRegistry();
  loadOnDiskSkills(skills);

  // Register every tool named by any loaded skill, plus common standalone pins.
  const needed = new Set<string>();
  for (const s of skills.list()) {
    for (const t of s.manifest.tools) needed.add(t);
  }
  for (const pin of config.pinned_skills ?? []) {
    needed.add(pin);
  }
  // Standalone / polymorphic pins that are not skill names
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
    'create_doc',
    'search_drive_files',
  ]) {
    needed.add(extra);
  }
  for (const name of needed) {
    if (!tools.get(name)) tools.register(toolManifest(name), noopHandler);
  }

  // MCP projection stub for coordinator
  if ((config.pinned_skills ?? []).includes('google-workspace')) {
    skills.register(
      {
        name: 'google-workspace',
        description: 'MCP google-workspace',
        tools: ['create_doc', 'search_drive_files'],
        instructions: '',
      },
      '',
    );
  }

  registerSyntheticSingletonSkills(tools, skills);
  return resolvePinnedSkills(config.pinned_skills ?? [], skills, tools).toolNames.sort();
}

describe('resolved pin sets after #1494 bundling', () => {
  it('diagnostics resolves only the three read-only query tools + date-resolve + request-clarification', () => {
    expect(resolveAgent('diagnostics.yaml')).toEqual(
      ['audit-query', 'audit-trace', 'date-resolve', 'ops-lookup', 'request-clarification'].sort(),
    );
  });

  it('meeting-debrief keeps individual task-* pins (not plan/checkpoint from tasks bundle)', () => {
    const tools = resolveAgent('meeting-debrief.yaml');
    expect(tools).toEqual(
      expect.arrayContaining(['task-create', 'task-list', 'task-update', 'task-complete']),
    );
    expect(tools).not.toContain('plan');
    expect(tools).not.toContain('checkpoint');
    expect(tools).not.toContain('scheduler-report');
  });

  it('contacts does not gain entity-context via the contacts bundle', () => {
    const config = loadAgentConfig(resolve(agentsDir, 'contacts.yaml'));
    expect(config.pinned_skills).toContain('contacts');
    expect(config.pinned_skills).toContain('entity-context');
    const tools = resolveAgent('contacts.yaml');
    expect(tools).toContain('entity-context');
    expect(tools).toContain('contact-lookup');
    expect(tools).toContain('contact-grant-permission');
  });

  it('ceo-inbox learning producers do not pull digest review tools', () => {
    const tools = resolveAgent('ceo-inbox.yaml');
    expect(tools).toEqual(expect.arrayContaining(['voice-learn', 'task-completion-from-sent']));
    expect(tools).not.toContain('list-learning-digest');
    expect(tools).not.toContain('resolve-learning-digest');
  });

  it('coordinator pins google-workspace skill instead of listing MCP tools', () => {
    const config = loadAgentConfig(resolve(agentsDir, 'coordinator.yaml'));
    expect(config.pinned_skills).toContain('google-workspace');
    expect(config.pinned_skills).not.toContain('create_doc');
    expect(config.pinned_skills).toContain('contact-update');
    expect(config.pinned_skills).not.toContain('contact-lookup');
  });
});
