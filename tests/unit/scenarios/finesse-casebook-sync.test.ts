// The finesse casebook is the source of truth for the finesse cases (#2556): review edits go
// into the casebook first, then the YAML. This keeps the two from drifting apart in the one
// way a test can see: every casebook case has a case file, and every finesse case file has a
// casebook case. Content drift (a changed right call) still needs a person to diff them.
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadScenarioCases } from '../../scenarios/loader.js';

const REPO = path.resolve(import.meta.dirname, '../../..');
const CASEBOOK = path.join(REPO, 'docs/wip/2026-11-10-finesse-casebook.md');
const CASES_DIR = path.join(REPO, 'tests/scenarios/cases');

/** "### 50a · Board update…" → 50a. */
function casebookIds(markdown: string): string[] {
  return [...markdown.matchAll(/^###\s+(5\d[a-z])\s+·/gm)].map(m => m[1]!);
}

/** "50a-finesse-drops-out-board-update.yaml" → 50a. */
function fileId(file: string): string | undefined {
  return /^(5\d[a-z])-/.exec(path.basename(file))?.[1];
}

describe('finesse casebook and case files (#2556)', () => {
  const ids = casebookIds(readFileSync(CASEBOOK, 'utf-8'));
  const finesse = loadScenarioCases(CASES_DIR).filter(c => c.tags.includes('finesse'));

  it('reads the casebook case ids', () => {
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a case file for every casebook case, and a casebook case for every finesse file', () => {
    const files = finesse.map(c => fileId(c.sourceFile));
    expect(files.filter(id => id === undefined), 'finesse case files must be named 5Xy-…').toEqual([]);
    expect([...files].sort()).toEqual([...ids].sort());
  });

  it('tags every 5Xy case file finesse', () => {
    const untagged = readdirSync(CASES_DIR)
      .filter(f => fileId(f) !== undefined)
      .filter(f => !finesse.some(c => path.basename(c.sourceFile) === f));
    expect(untagged).toEqual([]);
  });

  it('keeps finesse cases out of the release gate', () => {
    expect(finesse.filter(c => c.releaseGate).map(c => c.name)).toEqual([]);
  });
});
