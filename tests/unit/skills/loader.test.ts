import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadSkillsFromDirectory } from '../../../src/skills/loader.js';
import { SkillRegistry } from '../../../src/skills/registry.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('loadSkillsFromDirectory', () => {
  it('loads the web-fetch skill from the skills directory', async () => {
    const registry = new SkillRegistry();
    const skillsDir = path.resolve(import.meta.dirname, '../../../skills');

    await loadSkillsFromDirectory(skillsDir, registry, logger);

    const webFetch = registry.get('web-fetch');
    expect(webFetch).toBeDefined();
    expect(webFetch!.manifest.name).toBe('web-fetch');
    expect(webFetch!.manifest.description).toContain('web page');
  });

  it('returns the count of loaded skills', async () => {
    const registry = new SkillRegistry();
    const skillsDir = path.resolve(import.meta.dirname, '../../../skills');

    const count = await loadSkillsFromDirectory(skillsDir, registry, logger);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('throws for a nonexistent directory', async () => {
    const registry = new SkillRegistry();
    await expect(loadSkillsFromDirectory('/tmp/nonexistent-dir-xyz', registry, logger))
      .rejects.toThrow();
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
  it('produces valid tool definitions for every installed skill', async () => {
    const registry = new SkillRegistry();
    const skillsDir = path.resolve(import.meta.dirname, '../../../skills');

    await loadSkillsFromDirectory(skillsDir, registry, logger);

    const allSkillNames = registry.list().map(s => s.manifest.name);
    expect(allSkillNames.length).toBeGreaterThan(0);

    // Will throw with a clear per-skill error if any manifest is malformed.
    const tools = registry.toToolDefinitions(allSkillNames);
    expect(tools).toHaveLength(allSkillNames.length);

    for (const tool of tools) {
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.properties).toBeDefined();
    }
  });
});
