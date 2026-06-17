import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
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

  // PR2 (#939): install.requires_secrets is normalized at this lenient-discovery boundary
  // (raw JSON.parse, no Ajv), so a malformed manifest can't leak a non-array/non-string
  // shape into the registry gate or vault scope guard.
  describe('install.requires_secrets normalization', () => {
    // mkdtempSync creates a directory with a random suffix, avoiding the
    // predictable path that triggers CWE-377 (insecure temp file creation).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-loader-requires-secrets-'));

    function writeSkill(name: string, install: unknown): void {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({
        name, description: 'd', version: '1.0.0', action_risk: 'none', install,
      }));
    }

    afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('keeps a well-formed string array', () => {
      writeSkill('good', { requires_secrets: ['a', 'b'] });
      const disc = discoverSkillManifests(tmpDir).find(d => d.name === 'good');
      expect(disc?.metadata?.requiresSecrets).toEqual(['a', 'b']);
    });

    it('coerces a non-array value to undefined (no requirement)', () => {
      writeSkill('bad-string', { requires_secrets: 'tavily_api_key' });
      const disc = discoverSkillManifests(tmpDir).find(d => d.name === 'bad-string');
      // Must NOT be the raw string — that would iterate char-by-char downstream.
      expect(disc?.metadata?.requiresSecrets).toBeUndefined();
    });

    it('drops non-string entries from a mixed array', () => {
      writeSkill('mixed', { requires_secrets: ['ok', 42, null, 'fine'] });
      const disc = discoverSkillManifests(tmpDir).find(d => d.name === 'mixed');
      expect(disc?.metadata?.requiresSecrets).toEqual(['ok', 'fine']);
    });

    it('leaves requiresSecrets undefined when there is no install block', () => {
      writeSkill('none', undefined);
      const disc = discoverSkillManifests(tmpDir).find(d => d.name === 'none');
      expect(disc?.metadata?.requiresSecrets).toBeUndefined();
    });
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
