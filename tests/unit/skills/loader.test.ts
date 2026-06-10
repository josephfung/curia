import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { discoverSkillManifests, loadSkillsFromDirectory } from '../../../src/skills/loader.js';
import { SkillRegistry } from '../../../src/skills/registry.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('loadSkillsFromDirectory', () => {
  it('loads the web-fetch skill from the skills directory', async () => {
    const registry = new SkillRegistry();
    const skillsDir = path.resolve(import.meta.dirname, '../../../skills');

    // Discover all skills, then enable only web-fetch so we don't pay the
    // full dynamic-import cost for 90+ handlers in a 5 s test timeout.
    const discoveries = discoverSkillManifests(skillsDir);
    await loadSkillsFromDirectory(discoveries, registry, logger, new Set(['web-fetch']));

    const webFetch = registry.get('web-fetch');
    expect(webFetch).toBeDefined();
    expect(webFetch!.manifest.name).toBe('web-fetch');
    expect(webFetch!.manifest.description).toContain('web page');
  });

  it('returns the count of loaded skills', async () => {
    const registry = new SkillRegistry();
    const skillsDir = path.resolve(import.meta.dirname, '../../../skills');

    // Enable only web-fetch — we just need to confirm the return value
    // reflects the actual number of registered skills (1 here). Loading all
    // 90+ handlers would risk the 5 s vitest timeout on a cold import cache.
    const discoveries = discoverSkillManifests(skillsDir);
    const count = await loadSkillsFromDirectory(discoveries, registry, logger, new Set(['web-fetch']));
    expect(count).toBe(1);
  });

  it('throws for a nonexistent directory', async () => {
    // discoverSkillManifests now owns the directory scan, so it is the
    // function that throws when the directory doesn't exist.
    expect(() => discoverSkillManifests('/tmp/nonexistent-dir-xyz')).toThrow();
  });

  // Regression guard: every installed skill manifest must be convertible to a
  // valid tool definition. A malformed `inputs` shorthand (e.g. using an em-dash
  // instead of the supported `type (description)` form) only blows up inside
  // toToolDefinitions() at agent startup, which is too late — it takes down the
  // whole app and fails the container healthcheck. Running the conversion here
  // makes any such typo a CI failure instead of a prod-boot crash.
  //
  // Context: 2026-04-11 the email-archive manifest shipped with
  // `"message_id": "string — Nylas message ID..."`. The registry parsed the
  // entire string as the type, tripped the primitive-type allowlist, and curia
  // refused to start.
  // 30 s timeout: dynamically importing all skill handlers on a cold module
  // cache can exceed the default 5 s. This test must cover every installed
  // skill — it is the regression guard for malformed manifests.
  it('produces valid tool definitions for every installed skill', async () => {
    const registry = new SkillRegistry();
    const skillsDir = path.resolve(import.meta.dirname, '../../../skills');

    const discoveries = discoverSkillManifests(skillsDir);
    const enabledNames = new Set(discoveries.map(d => d.name));
    await loadSkillsFromDirectory(discoveries, registry, logger, enabledNames);

    const allSkillNames = registry.list().map(s => s.manifest.name);
    expect(allSkillNames.length).toBeGreaterThan(0);

    // Will throw with a clear per-skill error if any manifest is malformed.
    const tools = registry.toToolDefinitions(allSkillNames);
    expect(tools).toHaveLength(allSkillNames.length);

    for (const tool of tools) {
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.properties).toBeDefined();
    }
  }, 30_000);
});
