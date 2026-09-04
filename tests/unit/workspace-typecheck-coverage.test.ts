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
// every workspace package that has a tsconfig.json must declare a `typecheck` script.

const REPO_ROOT = join(import.meta.dirname, '../..');

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
}

/**
 * Resolve the workspace `packages:` globs from pnpm-workspace.yaml into concrete package
 * directories. Only the single-level `dir/*` form is used by this repo, so that is all we
 * expand — a more exotic glob should fail loudly here rather than be silently under-matched.
 */
function workspacePackageDirs(): string[] {
  const workspaceFile = join(REPO_ROOT, 'pnpm-workspace.yaml');
  const parsed = yaml.load(readFileSync(workspaceFile, 'utf8')) as { packages?: string[] };
  const globs = parsed.packages ?? [];
  expect(globs.length, 'pnpm-workspace.yaml declares no packages').toBeGreaterThan(0);

  const dirs: string[] = [];
  for (const glob of globs) {
    expect(glob.endsWith('/*'), `unsupported workspace glob "${glob}" — update this test`).toBe(
      true,
    );
    const parent = join(REPO_ROOT, dirname(glob));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(parent, entry.name);
      if (existsSync(join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs;
}

describe('workspace typecheck coverage', () => {
  it('every workspace package with a tsconfig.json declares a typecheck script', () => {
    const dirs = workspacePackageDirs();
    expect(dirs.length, 'no workspace packages discovered').toBeGreaterThan(0);

    const uncovered: string[] = [];
    for (const dir of dirs) {
      // A package without its own tsconfig.json has no project for `tsc --noEmit` to check;
      // it is covered (or not) by the root projects instead, so it is not our concern here.
      if (!existsSync(join(dir, 'tsconfig.json'))) continue;

      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
      if (!pkg.scripts?.typecheck) {
        uncovered.push(pkg.name ?? dir);
      }
    }

    expect(
      uncovered,
      `these packages would be silently skipped by \`pnpm -r run typecheck\`: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it('the root typecheck script delegates recursively rather than naming packages', () => {
    const rootPkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as PackageJson;
    const typecheck = rootPkg.scripts?.typecheck ?? '';

    expect(typecheck).toContain('pnpm -r run typecheck');
    // A hand-maintained `--filter <pkg>` list is how console came to be missing in the
    // first place; recursion is the point of the fix.
    expect(typecheck).not.toContain('--filter');
  });
});
