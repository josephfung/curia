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
  it('diagnostics resolves query tools + resolve-time-window + date-resolve + request-clarification', () => {
    expect(resolveAgent('diagnostics.yaml')).toEqual(
      [
        'audit-query',
        'audit-trace',
        'date-resolve',
        'ops-lookup',
        'request-clarification',
        'resolve-time-window',
      ].sort(),
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

  // #1502: the KG relationship tools moved from the contacts bundle to the memory
  // bundle. They must NOT come along with the contacts bundle anymore, and the
  // contacts agent keeps them only via its explicit individual pins (resolved set
  // unchanged). The coordinator gains them because it pins the whole memory bundle.
  it('query/delete-relationship live in the memory bundle, not contacts', () => {
    const skills = new SkillRegistry();
    loadOnDiskSkills(skills);
    const memory = skills.get('memory');
    const contacts = skills.get('contacts');
    expect(memory?.manifest.tools).toEqual(
      expect.arrayContaining(['query-relationships', 'delete-relationship']),
    );
    expect(contacts?.manifest.tools).not.toContain('query-relationships');
    expect(contacts?.manifest.tools).not.toContain('delete-relationship');
  });

  it('contacts still resolves the relationship tools via explicit individual pins', () => {
    const config = loadAgentConfig(resolve(agentsDir, 'contacts.yaml'));
    // contacts pins the contacts bundle (which no longer carries them) AND the two
    // tools individually — so removing them from the bundle is behavior-preserving.
    expect(config.pinned_skills).toContain('query-relationships');
    expect(config.pinned_skills).toContain('delete-relationship');
    const tools = resolveAgent('contacts.yaml');
    expect(tools).toContain('query-relationships');
    expect(tools).toContain('delete-relationship');
  });

  it('coordinator gains the relationship tools via the memory bundle (#1502)', () => {
    const tools = resolveAgent('coordinator.yaml');
    expect(tools).toEqual(
      expect.arrayContaining(['query-relationships', 'delete-relationship']),
    );
  });
});
