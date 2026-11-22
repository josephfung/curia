// Settings must stay out of agent reach (#2709): they are admin records, not something the
// knowledge graph or a skill tool may read or write. Nothing in the runtime stops a future
// handler from importing the store, so this test is the guard: no skill handler under
// skills/ may import src/settings/ (or the Setup projection that reads it).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKILLS_DIR = join(import.meta.dirname, '../../../skills');

function filesNamed(dir: string, name: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesNamed(full, name));
    else if (entry.name === name) found.push(full);
  }
  return found;
}

// Matches an import of the settings store or its Setup projection, wherever it sits.
const SETTINGS_IMPORT = /from\s+['"][^'"]*(?:\/settings\/(?:registry|store)|setup\/setup-settings)\.js['"]/;

describe('settings are not reachable from an agent tool', () => {
  it('finds the skill handlers it is checking', () => {
    // A path change that silently finds nothing would make the assertion below vacuous.
    expect(filesNamed(SKILLS_DIR, 'handler.ts').length).toBeGreaterThan(100);
  });

  it('no tool.json handler imports the settings store', () => {
    const offenders = filesNamed(SKILLS_DIR, 'handler.ts')
      .filter((file) => SETTINGS_IMPORT.test(readFileSync(file, 'utf-8')))
      .map((file) => relative(SKILLS_DIR, file));
    expect(offenders).toEqual([]);
  });

  it('no tool manifest declares a settings capability', () => {
    const offenders = filesNamed(SKILLS_DIR, 'tool.json')
      .filter((file) => {
        const manifest = JSON.parse(readFileSync(file, 'utf-8')) as { capabilities?: unknown };
        return Array.isArray(manifest.capabilities)
          && manifest.capabilities.some((name) => typeof name === 'string' && /settings/i.test(name));
      })
      .map((file) => relative(SKILLS_DIR, file));
    expect(offenders).toEqual([]);
  });
});
