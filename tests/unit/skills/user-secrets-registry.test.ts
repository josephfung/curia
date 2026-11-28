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

  it('gives the vault tools to no agent without discovery except setup-wizard (#2764, #995)', () => {
    // The vault tools carry no allowed_callers: #995 lets a delegated specialist that a
    // deployment deliberately gives secret-capture-request mint a capture link. What keeps
    // other specialists (ceo-inbox reading inbound mail) off the vault is that skill-activate
    // refuses skills an agent without discovery does not list (skill-activate handler tests),
    // and that no shipped agent lists or pins them here.
    const vault = new Set(['secrets', 'list-user-secrets', 'secret-capture-request']);
    const agentsDir = path.resolve(import.meta.dirname, '../../../agents');
    for (const file of fs.readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'))) {
      const agent = yaml.load(fs.readFileSync(path.resolve(agentsDir, file), 'utf8')) as {
        name: string;
        allow_discovery?: boolean;
        pinned_skills?: string[];
      };
      if (agent.allow_discovery === true || agent.name === 'setup-wizard') continue;
      const reached = (agent.pinned_skills ?? []).filter((p) => vault.has(p));
      expect({ agent: agent.name, reached }).toEqual({ agent: agent.name, reached: [] });
    }
  });

  it('lets the secrets skill resolve for any agent once the gate above allows it', () => {
    const tools = new ToolRegistry();
    const skills = new SkillRegistry();
    const toolsDir = path.resolve(skillsDir, 'secrets', 'tools');
    for (const name of fs.readdirSync(toolsDir)) {
      const manifest = JSON.parse(
        fs.readFileSync(path.resolve(toolsDir, name, 'tool.json'), 'utf-8'),
      ) as ToolManifest;
      expect(manifest.allowed_callers).toBeUndefined();
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
    for (const agentId of ['coordinator', 'accounts-specialist']) {
      expect(
        resolveSkillActivation({ skillName: 'secrets', skillRegistry: skills, toolRegistry: tools, agentId }),
      ).not.toHaveProperty('error');
    }
  });
});
