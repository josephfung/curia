import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFragmentFiles, validateFragment } from '../../scripts/changelog-assemble.js';

// Every PR adds one fragment under `changes/` instead of editing CHANGELOG.md (see
// changes/README.md). This test fails the PR that adds a malformed fragment — before
// release time, when `pnpm changelog:assemble` would otherwise refuse the whole batch.
//
// On a release PR the fragments have been merged and deleted, so there is nothing to check.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CHANGES_DIR = join(REPO_ROOT, 'changes');
const fragments = listFragmentFiles(CHANGES_DIR);

describe('changelog fragments (changes/*.md)', () => {
  if (fragments.length === 0) {
    it('has no pending fragments (e.g. right after a release)', () => {
      expect(fragments).toEqual([]);
    });
    return;
  }

  it.each(fragments)('%s is a valid fragment', (name) => {
    expect(validateFragment(readFileSync(join(CHANGES_DIR, name), 'utf8'))).toEqual([]);
  });

  it.each(fragments)('%s has a branch-style file name', (name) => {
    // Branch names with slashes are written with dashes: chore/foo -> chore-foo.md
    expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/);
  });
});
