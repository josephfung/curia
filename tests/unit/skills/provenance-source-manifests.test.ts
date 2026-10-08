// Which tools are identifier sources (#2061, ADR-047). A tool's result counts as a source
// only when its manifest sets provenance_source, so this list is the whole of what can
// verify an address an agent enters. Adding a tool here is a security decision: its output
// must be data it read, never text a model wrote.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverSkillManifests } from '../../../src/skills/skill-loader.js';
import { loadAgentConfig } from '../../../src/agents/loader.js';

const ROOT = path.join(import.meta.dirname, '../../..');
const SKILLS_DIR = path.join(ROOT, 'skills');

function manifests(): Array<{ name: string; provenance_source?: unknown }> {
  const found: Array<{ name: string; provenance_source?: unknown }> = [];
  const read = (file: string) => found.push(JSON.parse(fs.readFileSync(file, 'utf-8')) as { name: string });
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const flat = path.join(SKILLS_DIR, entry.name, 'tool.json');
    if (fs.existsSync(flat)) read(flat);
    const toolsDir = path.join(SKILLS_DIR, entry.name, 'tools');
    if (!fs.existsSync(toolsDir)) continue;
    for (const tool of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      const nested = path.join(toolsDir, tool.name, 'tool.json');
      if (tool.isDirectory() && fs.existsSync(nested)) read(nested);
    }
  }
  return found;
}

describe('provenance_source manifests (#2061)', () => {
  it('marks exactly the tools that return data they read', () => {
    const sources = manifests().filter((m) => m.provenance_source === true).map((m) => m.name).sort();
    expect(sources).toEqual([
      'ceo-inbox-list',
      'ceo-inbox-read',
      'ceo-inbox-search',
      'email-get',
      'email-get-thread',
      'email-list',
      'file-parse',
      'web-fetch',
      'web-search',
    ]);
  });

  it('never marks a tool whose result a model wrote, or may echo', () => {
    const byName = new Map(manifests().map((m) => [m.name, m]));
    // delegate and bullpen return model text. doc-read and doc-search read the workspace
    // agents write with doc-write. web-browser results echo what the agent typed into a page.
    for (const name of ['delegate', 'bullpen', 'doc-read', 'doc-search', 'web-browser']) {
      expect(byName.get(name)?.provenance_source, name).toBeUndefined();
    }
  });
});

describe('contact-register placement (#2061)', () => {
  it('is not in the contacts bundle, and ceo-inbox still pins it', () => {
    const contacts = discoverSkillManifests(SKILLS_DIR).find((skill) => skill.name === 'contacts');
    const tools = contacts?.metadata?.tools ?? [];
    expect(tools).toContain('contact-create');
    expect(tools).not.toContain('contact-register');

    const ceoInbox = loadAgentConfig(path.join(ROOT, 'agents', 'ceo-inbox.yaml'));
    expect(ceoInbox.pinned_skills).toContain('contact-register');
  });
});
