import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// #848: backend unit tests live in tests/unit/, mirroring src/. Skill handler
// tests (skills/**) and app tests (apps/**) stay next to their packages; this
// guard only covers the top-level src/ tree, which had drifted into both layouts.

const SRC_ROOT = join(import.meta.dirname, '../../src');
const TEST_FILE = /\.test\.tsx?$/;
const SKIP_DIRS = new Set(['node_modules', 'dist']);

function colocatedTests(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      colocatedTests(full, found);
    } else if (TEST_FILE.test(entry.name)) {
      found.push(full.slice(SRC_ROOT.length + 1));
    }
  }
  return found;
}

describe('src test layout (#848)', () => {
  it('has no co-located *.test.ts files under src/', () => {
    expect(colocatedTests(SRC_ROOT)).toEqual([]);
  });
});
