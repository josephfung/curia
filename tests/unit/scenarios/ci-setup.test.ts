// The weekly behavior gate's database setup (tests/scenarios/ci-setup.ts). A renamed or
// removed agent or tool should fail here, not on a Sunday run with nobody watching.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ciRegistryRows } from '../../scenarios/ci-setup.js';

const ROOT = join(import.meta.dirname, '../../..');

describe('ciRegistryRows', () => {
  const rows = ciRegistryRows(ROOT);

  it('enables the opt-in agents the gate needs, each with its YAML', () => {
    expect(rows.agents).toEqual(['calendar', 'ceo-inbox']);
    for (const agent of rows.agents) expect(existsSync(join(ROOT, 'agents', `${agent}.yaml`))).toBe(true);
  });

  it('enables bundles that exist', () => {
    for (const skill of rows.skills) expect(existsSync(join(ROOT, 'skills', skill, 'SKILL.md'))).toBe(true);
  });

  it('enables only tools that have a manifest, including the inbox send and contact-register', () => {
    expect(rows.tools).toEqual(expect.arrayContaining(['calendar-list-events', 'ceo-inbox-send-draft', 'voice-learn', 'contact-register']));
    expect(new Set(rows.tools).size).toBe(rows.tools.length);
    for (const tool of rows.tools) {
      const manifests = [join(ROOT, 'skills', tool, 'tool.json'), ...['calendar', 'ceo-inbox', 'learning', 'contacts'].map(b => join(ROOT, 'skills', b, 'tools', tool, 'tool.json'))];
      expect(manifests.some(existsSync), `${tool} has no tool.json`).toBe(true);
    }
  });
});
