// skill-description-cap.test.ts — every skill description ≤ 300 chars (#2764).
//
// Descriptions drive on-demand loading: they must say what the skill does and
// when to load it, without maintainer notes. MCP projections read an optional
// description from config/skills.yaml.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillMd } from '../../../src/skills/skill-md.js';
import { loadSkillsConfig } from '../../../src/skills/mcp-loader.js';

const SKILL_DESCRIPTION_MAX = 300;
const skillsDir = resolve(import.meta.dirname, '../../../skills');
const configDir = resolve(import.meta.dirname, '../../../config');

function skillMdPaths(): string[] {
  return readdirSync(skillsDir)
    .map((name) => join(skillsDir, name, 'SKILL.md'))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

describe('skill description cap (#2764)', () => {
  it(`every SKILL.md description is ≤ ${SKILL_DESCRIPTION_MAX} characters`, () => {
    const overs: Array<{ path: string; length: number; description: string }> = [];
    for (const path of skillMdPaths()) {
      const parsed = parseSkillMd(readFileSync(path, 'utf-8'), path);
      const description = parsed.description.trim();
      if (description.length > SKILL_DESCRIPTION_MAX) {
        overs.push({ path, length: description.length, description });
      }
    }
    expect(
      overs,
      overs.map((o) => `${o.path}: ${o.length} chars`).join('\n') || undefined,
    ).toEqual([]);
  });

  it(`every configured MCP skill description is ≤ ${SKILL_DESCRIPTION_MAX} characters`, () => {
    const overs: Array<{ name: string; length: number }> = [];
    for (const server of loadSkillsConfig(configDir).servers ?? []) {
      const description = server.description?.trim();
      if (!description) continue;
      if (description.length > SKILL_DESCRIPTION_MAX) {
        overs.push({ name: server.name, length: description.length });
      }
    }
    expect(overs).toEqual([]);
  });

  it('google-workspace has a hand-written description in skills.yaml', () => {
    const gw = (loadSkillsConfig(configDir).servers ?? []).find((s) => s.name === 'google-workspace');
    expect(gw?.description?.trim().length).toBeGreaterThan(40);
    expect(gw?.description).toMatch(/Drive/i);
    expect(gw?.description).toMatch(/Load when/i);
  });

  // Descriptions drive on-demand loading (#2764): each must say what the skill does
  // and when to load it. The when-clause is the "Load when/for/…" cue already used
  // for google-workspace; bodies hold the rest of the procedure.
  const WHEN_CLAUSE = /\bLoad (?:when|for|whenever|only if)\b/i;

  it('every SKILL.md description says when to load the skill', () => {
    const missing: Array<{ path: string; description: string }> = [];
    for (const path of skillMdPaths()) {
      const parsed = parseSkillMd(readFileSync(path, 'utf-8'), path);
      const description = parsed.description.trim();
      if (!WHEN_CLAUSE.test(description)) {
        missing.push({ path, description });
      }
    }
    expect(
      missing,
      missing.map((m) => `${m.path}: ${m.description}`).join('\n') || undefined,
    ).toEqual([]);
  });

  it('every configured MCP skill description says when to load the skill', () => {
    const missing: string[] = [];
    for (const server of loadSkillsConfig(configDir).servers ?? []) {
      const description = server.description?.trim();
      if (!description) continue;
      if (!WHEN_CLAUSE.test(description)) missing.push(server.name);
    }
    expect(missing).toEqual([]);
  });
});
