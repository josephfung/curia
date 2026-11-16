// bundle-tool-membership.test.ts — every tool shipped inside a bundle directory is a
// member of that bundle.
//
// A tool under skills/<bundle>/tools/<name>/ enrolls only through its bundle's SKILL.md
// `tools:` list (#1974). Drop it from that list and nothing fails: the tool still loads
// from disk in unit tests, but no registry row is ever written, so no agent can reach it
// in a real stack. That is how card-use-request and card-use-confirm went dark: a
// "revert version bumps" commit restored the old web/SKILL.md wholesale and took the two
// new entries with it, and only the paid scenario gate noticed (42a/42b, "not a
// registered tool"). registry-defaults-coverage.test.ts checks the members a SKILL.md
// lists; this checks the other direction — directories the SKILL.md forgot.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { discoverToolManifests } from '../../../src/skills/loader.js';
import { discoverSkillManifests } from '../../../src/skills/skill-loader.js';

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../../skills');

/**
 * Bundle-directory tools deliberately left out of their bundle's `tools:` list, with why.
 * Adding one here is a decision, not a fix for a red test — say who reaches it instead.
 */
const NOT_BUNDLE_MEMBERS: Readonly<Record<string, string>> = {
  // ceo-inbox only (#2041): pinned by name in agents/ceo-inbox.yaml so pinning the
  // contacts bundle does not hand it to every agent.
  // TODO: confirm how it is enrolled on a fresh install; it is in neither the contacts
  // bundle nor registry-defaults `tools:`.
  'contacts/contact-register': 'pinned directly by ceo-inbox (#2041)',
};

describe('bundle tool membership', () => {
  it('lists every tool under skills/<bundle>/tools/ in that bundle\'s SKILL.md', () => {
    const listed = new Map<string, Set<string>>();
    for (const s of discoverSkillManifests(SKILLS_DIR)) {
      if (s.metadata) listed.set(s.name, new Set(s.metadata.tools));
    }

    const unlisted: string[] = [];
    for (const [key, toolName] of nestedTools()) {
      if (key in NOT_BUNDLE_MEMBERS) continue;
      const [bundle] = key.split('/') as [string];
      if (!listed.get(bundle)?.has(toolName)) unlisted.push(key);
    }

    expect(unlisted).toEqual([]);
  });

  it('finds nested bundle tools at all', () => {
    // Without this, a layout change that matched nothing would leave the check above vacuous.
    expect(nestedTools().has('web/card-use-request')).toBe(true);
  });

  it('keeps every exception pointing at a tool that exists and is still unlisted', () => {
    // A stale exception would quietly exempt a future tool reusing the name.
    for (const key of Object.keys(NOT_BUNDLE_MEMBERS)) {
      const [bundle, tool] = key.split('/') as [string, string];
      expect(nestedTools().has(key), `${key} is not a tool directory`).toBe(true);
      const skill = discoverSkillManifests(SKILLS_DIR).find(s => s.name === bundle);
      expect(skill?.metadata, `${bundle} SKILL.md did not parse`).toBeTruthy();
      expect(skill!.metadata!.tools, key).not.toContain(tool);
    }
  });
});

/** Nested bundle tools, `<bundle>/<dir>` → tool name. Only skills/<bundle>/tools/<dir> belongs to a bundle. */
function nestedTools(): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of discoverToolManifests(SKILLS_DIR)) {
    const rel = path.relative(SKILLS_DIR, t.dir).split(path.sep);
    if (rel.length !== 3 || rel[1] !== 'tools') continue;
    const [bundle, , dirName] = rel as [string, string, string];
    out.set(`${bundle}/${dirName}`, t.metadata?.name ?? dirName);
  }
  return out;
}
