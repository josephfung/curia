import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import * as yaml from 'js-yaml';
import ts from 'typescript';

// Guard for #1729, the root-project counterpart to the workspace-package guard in
// workspace-typecheck-coverage.test.ts.
//
// The root `typecheck` script runs a fixed set of tsconfig projects (`src/**`,
// `skills/**`, `tests/**`) and then `pnpm -r run typecheck` for the workspace packages.
// Anything that is neither inside one of those projects nor inside a workspace package
// is checked by *nothing* — which is exactly where `scripts/**` and `vitest.config.ts`
// sat: 13 live type errors in maintenance tools that get run against production, plus
// four test files that CI executes on every PR but never typechecked.
//
// Rather than assert the current file list (which would need editing every time a file
// is added), this derives the projects from the root `typecheck` script and asserts that
// every TypeScript file outside the workspace packages lands in at least one of them.
// A new top-level tree is therefore covered on day one or fails here.

const REPO_ROOT = join(import.meta.dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
// Every extension tsc treats as input, matching the workspace guard.
const TS_EXTENSION = /\.(?:[cm]?ts|tsx)$/;
// Ambient declarations are inputs to whichever project references them; they carry no
// checkable code of their own and are pulled in implicitly, so they are not the gap.
const DECLARATION_EXTENSION = /\.d\.[cm]?ts$/;

interface PackageJson {
  scripts?: Record<string, string>;
}

/**
 * The tsconfig projects the root `typecheck` script actually runs, in script order.
 *
 * Derived from the script rather than hardcoded: a project added to the repo but never
 * wired into `typecheck` provides no coverage, and this test must see the same set CI
 * does. A bare `tsc --noEmit` (no `-p`) means the default `tsconfig.json`.
 */
function rootTypecheckProjects(): string[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as PackageJson;
  const script = pkg.scripts?.typecheck;
  expect(script, 'root package.json declares no typecheck script').toBeTruthy();

  const projects: string[] = [];
  for (const segment of script!.split(/&&|\|\||[;|]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    // Skip runner prefixes (`pnpm exec tsc`, `npx tsc`) the way the workspace guard does.
    let i = 0;
    while (i < words.length && words[i] !== 'tsc') i++;
    if (words[i] !== 'tsc') continue;

    const args = words.slice(i + 1);
    const flag = args.findIndex((arg) => arg === '-p' || arg === '--project');
    projects.push(flag === -1 ? 'tsconfig.json' : args[flag + 1]!);
  }

  expect(projects.length, 'no tsc invocations found in the root typecheck script').toBeGreaterThan(
    0,
  );
  return projects;
}

/** Absolute paths of the workspace package directories (`apps/*`, `packages/*`). */
function workspacePackageDirs(): string[] {
  const parsed = yaml.load(readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8')) as {
    packages?: string[];
  };
  const globs = parsed.packages ?? [];
  expect(globs.length, 'pnpm-workspace.yaml declares no packages').toBeGreaterThan(0);

  const dirs: string[] = [];
  for (const glob of globs) {
    expect(
      glob.endsWith('/*') && !glob.startsWith('!'),
      `unsupported workspace glob "${glob}" — update this test rather than letting it over-match`,
    ).toBe(true);

    const parent = join(REPO_ROOT, dirname(glob));
    expect(existsSync(parent), `workspace glob "${glob}" resolves to a missing directory`).toBe(
      true,
    );
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const dir = join(parent, entry.name);
      if (existsSync(join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  expect(dirs.length, 'no workspace packages resolved').toBeGreaterThan(0);
  return dirs;
}

/** Every TypeScript file under `dir`, recursively, skipping build output and `skip`ped trees. */
function collectTsFiles(dir: string, skip: Set<string>, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || skip.has(full)) continue;
      collectTsFiles(full, skip, out);
    } else if (TS_EXTENSION.test(entry.name) && !DECLARATION_EXTENSION.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The root files of a tsconfig project — its `include`/`files` globs resolved against
 * disk, which is what tsc itself starts from.
 *
 * Deliberately *not* the transitive import closure. `scripts/seed-vault.ts` was reached
 * only because a test happened to import it; delete that import and the file silently
 * leaves the check. Incidental coverage is not coverage, so it does not count here.
 */
function projectFiles(project: string): string[] {
  const configPath = join(REPO_ROOT, project);
  expect(
    existsSync(configPath),
    `typecheck script runs "${project}" but no such tsconfig exists`,
  ).toBe(true);

  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(
        `could not parse ${project}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
      );
    },
  });
  expect(parsed, `could not parse ${project}`).toBeTruthy();
  return parsed!.fileNames.map((f) => resolve(f));
}

describe('root typecheck coverage', () => {
  it('every TypeScript file outside the workspace packages is in a root tsconfig project', () => {
    const skip = new Set(workspacePackageDirs());
    const candidates = collectTsFiles(REPO_ROOT, skip);
    // Without this the assertion below would pass on an empty candidate set — the same
    // vacuous-green failure mode the guard exists to catch.
    expect(candidates.length, 'no TypeScript files were inspected').toBeGreaterThan(0);

    const covered = new Set(rootTypecheckProjects().flatMap(projectFiles));
    const uncovered = candidates
      .filter((file) => !covered.has(file))
      .map((file) => relative(REPO_ROOT, file));

    expect(
      uncovered,
      `these files are typechecked by nothing — no root tsconfig project includes them, ` +
        `and they are not in a workspace package: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it('scripts/ is covered specifically, since those tools run against production', () => {
    // The general assertion above would also be satisfied by dropping scripts/ from the
    // repo. This pins the case that motivated #1729 so the coverage cannot quietly narrow.
    const covered = new Set(rootTypecheckProjects().flatMap(projectFiles));
    const scriptFiles = collectTsFiles(join(REPO_ROOT, 'scripts'), new Set());

    expect(scriptFiles.length, 'no files found under scripts/').toBeGreaterThan(0);
    // Both halves matter and land in different projects: the tools in
    // tsconfig.scripts.json, their tests in tsconfig.tests.json.
    expect(
      scriptFiles.some((f) => f.endsWith('.test.ts')),
      'no test files found under scripts/ — vitest runs them, so they must be checked',
    ).toBe(true);

    const uncovered = scriptFiles
      .filter((file) => !covered.has(file))
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'));
    expect(uncovered, `uncovered scripts/ files: ${uncovered.join(', ')}`).toEqual([]);
  });
});
