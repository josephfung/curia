import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as yaml from 'js-yaml';

// Guard for #1726. The root `typecheck` script used to enumerate workspace packages by
// hand (`pnpm --filter @curia/antfarm run typecheck`) and had drifted: `apps/console` was
// never checked, so the documented command reported success over real type errors.
//
// It now delegates to `pnpm -r run typecheck`, which cannot drift as packages are added.
// But `pnpm -r run` *silently skips* any package that does not define the script — which
// would reintroduce the same failure mode one level down. This test makes that skip loud:
// every workspace package that ships TypeScript must declare a `typecheck` script that
// actually runs `tsc`.
//
// The trigger is "has .ts sources", not "has a tsconfig.json". A package with sources but
// no tsconfig is exactly the dangerous case: `pnpm -r` skips it and the root projects do
// not reach it either (they include `src/**`, `skills/**` and `tests/**` only), so it is
// checked only incidentally, if some consumer happens to import it. That is not coverage.
//
// Everything here is written to fail loudly rather than pass vacuously — a guard test that
// silently inspects nothing is the same defect it exists to catch.

const REPO_ROOT = join(import.meta.dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
}

/**
 * Resolve the workspace `packages:` globs from pnpm-workspace.yaml into concrete package
 * directories, keyed by the glob that produced them. Only the single-level `dir/*` form is
 * used by this repo, so that is all we expand — any other form (including pnpm's
 * `!`-prefixed exclusions, which also end in `/*`) fails here rather than being silently
 * mis-expanded.
 */
function workspacePackageDirsByGlob(): Map<string, string[]> {
  const workspaceFile = join(REPO_ROOT, 'pnpm-workspace.yaml');
  const parsed = yaml.load(readFileSync(workspaceFile, 'utf8')) as { packages?: string[] };
  const globs = parsed.packages ?? [];
  expect(globs.length, 'pnpm-workspace.yaml declares no packages').toBeGreaterThan(0);

  const byGlob = new Map<string, string[]>();
  for (const glob of globs) {
    expect(
      glob.endsWith('/*') && !glob.startsWith('!'),
      `unsupported workspace glob "${glob}" — update this test rather than letting it under-match`,
    ).toBe(true);

    const parent = join(REPO_ROOT, dirname(glob));
    // Deliberately not `continue` on a missing parent: if `apps/` is renamed or deleted,
    // every package under it would vanish from the check with no signal at all.
    expect(existsSync(parent), `workspace glob "${glob}" resolves to a missing directory`).toBe(
      true,
    );

    const dirs: string[] = [];
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const dir = join(parent, entry.name);
      if (existsSync(join(dir, 'package.json'))) dirs.push(dir);
    }
    expect(dirs.length, `workspace glob "${glob}" matched no packages`).toBeGreaterThan(0);
    byGlob.set(glob, dirs);
  }
  return byGlob;
}

/** True if the directory tree holds at least one .ts/.tsx file outside build output. */
function hasTypeScriptSources(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (hasTypeScriptSources(join(dir, entry.name))) return true;
    } else if (/\.tsx?$/.test(entry.name)) {
      return true;
    }
  }
  return false;
}

describe('workspace typecheck coverage', () => {
  it('every workspace package shipping TypeScript declares a typecheck script that runs tsc', () => {
    const dirs = [...workspacePackageDirsByGlob().values()].flat();

    const missing: string[] = [];
    const notRunningTsc: string[] = [];
    let inspected = 0;

    for (const dir of dirs) {
      if (!hasTypeScriptSources(dir)) continue;
      inspected++;

      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
      const name = pkg.name ?? dir;
      const script = pkg.scripts?.typecheck;

      if (!script) {
        missing.push(name);
      } else if (!/\btsc\b/.test(script)) {
        // A `typecheck` script that never invokes tsc (`echo ok`, `exit 0`) satisfies
        // `pnpm -r` and is green forever — success reported over an unchecked package.
        notRunningTsc.push(`${name} (${script})`);
      }
    }

    // Without this the assertions below would pass on an empty inspection set.
    expect(inspected, 'no TypeScript workspace packages were inspected').toBeGreaterThan(0);
    expect(
      missing,
      `these packages would be silently skipped by \`pnpm -r run typecheck\`: ${missing.join(', ')}`,
    ).toEqual([]);
    expect(
      notRunningTsc,
      `these packages declare a typecheck script that never runs tsc: ${notRunningTsc.join(', ')}`,
    ).toEqual([]);
  });

  it('the root typecheck script delegates recursively rather than naming packages', () => {
    const rootPkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as PackageJson;
    const typecheck = rootPkg.scripts?.typecheck ?? '';

    // Tolerant of added flags (e.g. `--if-present`) but not of losing the recursion.
    expect(typecheck).toMatch(/pnpm -r\b[^&|]*\brun typecheck\b/);
    // A hand-maintained `--filter <pkg>` list is how console came to be missing in the
    // first place; recursion is the point of the fix.
    expect(typecheck).not.toContain('--filter');
  });
});
