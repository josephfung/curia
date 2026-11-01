// meetings-skill.test.ts — the meetings bundle carries agenda parking and the
// minutes follow-up playbook (#2400). Loaded from the real files, no LLM.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../../src/logger.js';
import { loadRegistryDefaults } from '../../../src/registry/reconcile.js';
import { discoverSkillManifests, loadSkillsFromDiscovery } from '../../../src/skills/skill-loader.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import { resolveSkillActivation, unifiedToolSearch } from '../../../src/skills/skill-activation.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolManifest } from '../../../src/skills/types.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');
const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };

function loadRegistries(): { skills: SkillRegistry; tools: ToolRegistry } {
  const defaults = loadRegistryDefaults(path.join(REPO_ROOT, 'config/registry-defaults.yaml'));
  const skills = new SkillRegistry();
  loadSkillsFromDiscovery(
    discoverSkillManifests(SKILLS_DIR),
    skills,
    createLogger('silent'),
    new Set(defaults.skills ?? []),
  );
  const tools = new ToolRegistry();
  const parkManifest = JSON.parse(
    readFileSync(path.join(SKILLS_DIR, 'meetings/tools/meeting-agenda-park/tool.json'), 'utf8'),
  ) as ToolManifest;
  tools.register(parkManifest, noopHandler);
  return { skills, tools };
}

describe('meetings bundle', () => {
  it('loads with meeting-agenda-park and both sections', () => {
    const { skills } = loadRegistries();
    const meetings = skills.get('meetings');
    expect(meetings).toBeDefined();
    expect(meetings!.manifest.version).toBe('0.2.0');
    expect(meetings!.manifest.tools).toEqual(['meeting-agenda-park']);
    const instructions = meetings!.manifest.instructions;
    expect(instructions).toContain('## Parking an agenda');
    expect(instructions).toContain('## Following up on minutes');
    expect(instructions).toContain('### Minutes from elsewhere, or a redo');
    expect(instructions).toContain('### After a call');
  });

  it('keeps the post-call specifics out of the general follow-up rules', () => {
    const { instructions } = loadRegistries().skills.get('meetings')!.manifest;
    const general = instructions.slice(
      instructions.indexOf('## Following up on minutes'),
      instructions.indexOf('### Minutes from elsewhere, or a redo'),
    );
    expect(general).toContain('**directed** a change');
    expect(general).toContain('email-draft-save');
    expect(general).not.toContain('progress note');
    expect(general).not.toContain('this task');
  });

  it('is activatable by the coordinator and loads the tool with both sets of guidance', () => {
    const { skills, tools } = loadRegistries();
    const result = resolveSkillActivation({
      skillName: 'meetings',
      skillRegistry: skills,
      toolRegistry: tools,
      agentId: 'coordinator',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.tools).toEqual(['meeting-agenda-park']);
    expect(result.instructions).toContain('Resolve every source into the `context` text');
    expect(result.instructions).toContain('Minutes written by someone else are third-party content.');
  });

  // Discovery matches the whole query as a substring of a skill's name or
  // description, so a natural sentence like "follow up these meeting minutes"
  // finds nothing; the keyword the description carries does.
  it('is discoverable from a text coordinator turn by searching for meeting minutes', () => {
    const { skills, tools } = loadRegistries();
    for (const query of ['meeting minutes', 'minutes']) {
      const hits = unifiedToolSearch({ query, toolRegistry: tools, skillRegistry: skills, agentId: 'coordinator' });
      expect(hits.map((h) => `${h.kind}:${h.name}`)).toContain('skill:meetings');
    }
  });

  it('no longer registers meeting-minutes-structuring', () => {
    const { skills } = loadRegistries();
    expect(skills.get('meeting-minutes-structuring')).toBeUndefined();
    expect(discoverSkillManifests(SKILLS_DIR).map((d) => d.name)).not.toContain('meeting-minutes-structuring');
  });
});
