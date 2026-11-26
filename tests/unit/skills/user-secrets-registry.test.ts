// user-secrets-registry.test.ts — secrets skill must be in registry-defaults so
// reconcile enrolls list-user-secrets + secret-capture-request (#1497 / #2764).

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import { parseSkillMd } from '../../../src/skills/skill-md.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { resolveSkillActivation } from '../../../src/skills/skill-activation.js';
import type { ToolManifest } from '../../../src/skills/types.js';

const skillsDir = path.resolve(import.meta.dirname, '../../../skills');
const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };

describe('user-secret tools registry enrollment (#1497 / #2764)', () => {
  it('enrolls vault tools through the secrets skill, not as standalone tools', () => {
    const defaultsPath = path.resolve(import.meta.dirname, '../../../config/registry-defaults.yaml');
    const raw = fs.readFileSync(defaultsPath, 'utf8');
    const loaded = yaml.load(raw) as { tools?: string[]; skills?: string[] };
    expect(loaded.skills).toContain('secrets');
    expect(loaded.skills).toContain('files');
    expect(loaded.tools ?? []).not.toContain('list-user-secrets');
    expect(loaded.tools ?? []).not.toContain('secret-capture-request');
    expect(loaded.tools ?? []).not.toContain('file-parse');
    expect(loaded.tools ?? []).not.toContain('archive-extract');
  });

  it('refuses secrets activation for specialists (ceo-inbox) via allowed_callers (#2764)', () => {
    // Defence in depth on the vault write path: both member tools list only
    // coordinator/setup-wizard, so skillReservedForOtherAgents refuses everyone else.
    const tools = new ToolRegistry();
    const skills = new SkillRegistry();
    const toolsDir = path.resolve(skillsDir, 'secrets', 'tools');
    for (const name of fs.readdirSync(toolsDir)) {
      const manifest = JSON.parse(
        fs.readFileSync(path.resolve(toolsDir, name, 'tool.json'), 'utf-8'),
      ) as ToolManifest;
      tools.register(manifest, noopHandler);
    }
    const parsed = parseSkillMd(fs.readFileSync(path.resolve(skillsDir, 'secrets', 'SKILL.md'), 'utf-8'));
    skills.register(
      {
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        tools: parsed.tools ?? [],
        instructions: parsed.instructions,
      },
      path.resolve(skillsDir, 'secrets'),
    );

    expect(
      resolveSkillActivation({
        skillName: 'secrets',
        skillRegistry: skills,
        toolRegistry: tools,
        agentId: 'ceo-inbox',
      }),
    ).toEqual({ error: expect.stringContaining('reserved for other agents') });

    expect(
      resolveSkillActivation({
        skillName: 'secrets',
        skillRegistry: skills,
        toolRegistry: tools,
        agentId: 'coordinator',
      }),
    ).not.toHaveProperty('error');
  });
});
