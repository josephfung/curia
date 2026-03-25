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
});
