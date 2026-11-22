// Settings must stay out of agent reach (#2709): they are admin records, not something the
// knowledge graph or a skill tool may read or write. `setup-status` and `onboarding-progress`
// see a read-only Setup projection through injected services; neither imports the store.
//
// Nothing in the runtime stops a skill file from importing it, so this test is the guard. It
// scans every non-test TypeScript file under skills/, not just handler.ts: a handler that
// imports a local helper which in turn imports the store would otherwise pass.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKILLS_DIR = join(import.meta.dirname, '../../../skills');

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesUnder(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(full);
  }
  return found;
}

// Matches an import of the settings store or its Setup projection, wherever it sits.
const SETTINGS_IMPORT = /from\s+['"][^'"]*(?:\/settings\/(?:registry|store)|setup\/setup-settings)\.js['"]/;

const agentSources = sourceFilesUnder(SKILLS_DIR).filter((file) => !/\.test\.tsx?$/.test(file));

describe('settings are not reachable from an agent tool', () => {
  it('finds the files it is checking', () => {
    // A path change that silently finds nothing would make the assertion below vacuous.
    expect(agentSources.length).toBeGreaterThan(100);
  });

  it('no non-test file under skills/ imports the settings store', () => {
    const offenders = agentSources
      .filter((file) => SETTINGS_IMPORT.test(readFileSync(file, 'utf-8')))
      .map((file) => relative(SKILLS_DIR, file));
    expect(offenders).toEqual([]);
  });

  it('no tool manifest declares a settings capability', () => {
    const offenders = sourceFilesUnder(SKILLS_DIR)
      .filter((file) => file.endsWith('tool.json'))
      .filter((file) => {
        const manifest = JSON.parse(readFileSync(file, 'utf-8')) as { capabilities?: unknown };
        return Array.isArray(manifest.capabilities)
          && manifest.capabilities.some((name) => typeof name === 'string' && /settings/i.test(name));
      })
      .map((file) => relative(SKILLS_DIR, file));
    expect(offenders).toEqual([]);
  });
});
