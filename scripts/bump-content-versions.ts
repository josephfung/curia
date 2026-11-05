// scripts/bump-content-versions.ts
//
// Release-time bump of agent and skill `version:` fields.
//
// Day-to-day PRs do NOT bump these versions (CLAUDE.md, "Versioning skills and
// agents"): two parallel PRs that each hand-bump the same file collide, and the
// bump says nothing the diff doesn't. Instead, the release PR runs this once. It
// finds every versioned unit whose content changed since the last release tag and
// raises its patch version, so a version still pins "a known config state" in
// logs and audit rows without anyone bumping by hand.
//
// A "unit" is:
//   agent   agents/<name>.yaml                          (version: "x.y.z")
//   tool    a skills/**/<tool>/ dir holding tool.json   (every non-test file in it)
//   bundle  skills/<bundle>/SKILL.md                    (that file only)
//
// A unit counts as changed when anything in it differs from the tag, ignoring the
// version line itself. A unit whose version already differs from the tag's was
// bumped by hand (say, a deliberate minor) and is left alone, so the script is
// idempotent and never overrides a human choice. A unit that did not exist at the
// tag is new and keeps its starting version.
//
// usage:
//   pnpm bump:versions                  # dry run against the latest v* tag
//   pnpm bump:versions --write          # apply the bumps
//   pnpm bump:versions --since v0.44.0  # compare against a specific ref
//
// Not covered: skills/_shared/ helpers. A change there alters behaviour without
// touching a tool dir, so tools that import it are not bumped.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

export type UnitKind = 'agent' | 'tool' | 'bundle';

export interface Unit {
  kind: UnitKind;
  /** Repo-relative path of the file that carries the `version` field. */
  versionFile: string;
  /** Repo-relative paths whose changes count as a content change for this unit. */
  scope: string[];
}

export interface Bump {
  unit: Unit;
  from: string;
  to: string;
}

export interface Skipped {
  unit: Unit;
  reason: 'unchanged' | 'new-since-tag' | 'already-bumped' | 'no-version';
}

/** Git access, injectable so planBumps is testable without a repository. */
export interface GitReader {
  /** Repo-relative files under `scope` that differ between `ref` and the working tree. */
  changedFiles(ref: string, scope: string[]): string[];
  /** File contents at `ref`, or null if the file did not exist there. */
  showAtRef(ref: string, file: string): string | null;
  /** Working-tree file contents. */
  readCurrent(file: string): string;
}

// The first `version` key in a file. Anchored to a line start (YAML, SKILL.md
// frontmatter) or to an indented JSON key, so a "version" inside a prompt body
// (indented YAML block text) is not matched.
const VERSION_LINE: Record<UnitKind, RegExp> = {
  agent: /^version:[ \t]*["']?([^"'\s]+)["']?[ \t]*$/m,
  bundle: /^version:[ \t]*["']?([^"'\s]+)["']?[ \t]*$/m,
  tool: /^[ \t]*"version"[ \t]*:[ \t]*"([^"]+)"[ \t]*,?[ \t]*$/m,
};

export function readVersion(kind: UnitKind, text: string): string | null {
  return VERSION_LINE[kind].exec(text)?.[1] ?? null;
}

/** The text with its version line removed, for "did anything else change" comparisons. */
export function stripVersion(kind: UnitKind, text: string): string {
  return text.replace(VERSION_LINE[kind], '');
}

/** Replace the version value in place, keeping the file's quoting and layout. */
export function setVersion(kind: UnitKind, text: string, next: string): string {
  return text.replace(VERSION_LINE[kind], (line, current: string) => line.replace(current, next));
}

export function bumpPatch(version: string): string {
  const next = semver.valid(version) ? semver.inc(version, 'patch') : null;
  if (!next) throw new Error(`cannot bump "${version}": not a valid semver`);
  return next;
}

function isTestFile(file: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(file) || file.includes('/__fixtures__/');
}

/**
 * Decide which units to bump. Pure apart from the injected `git` reader.
 */
export function planBumps(
  units: Unit[],
  ref: string,
  git: GitReader,
): { bumps: Bump[]; skipped: Skipped[] } {
  const bumps: Bump[] = [];
  const skipped: Skipped[] = [];

  for (const unit of units) {
    const current = git.readCurrent(unit.versionFile);
    const currentVersion = readVersion(unit.kind, current);
    if (!currentVersion) {
      skipped.push({ unit, reason: 'no-version' });
      continue;
    }

    const atRef = git.showAtRef(ref, unit.versionFile);
    if (atRef === null) {
      skipped.push({ unit, reason: 'new-since-tag' });
      continue;
    }
    if (readVersion(unit.kind, atRef) !== currentVersion) {
      skipped.push({ unit, reason: 'already-bumped' });
      continue;
    }

    const changed = git
      .changedFiles(ref, unit.scope)
      .filter((file) => !isTestFile(file))
      .some((file) => {
        if (file !== unit.versionFile) return true;
        // The version file itself only counts when something other than the
        // version line moved.
        return stripVersion(unit.kind, atRef) !== stripVersion(unit.kind, current);
      });

    if (!changed) {
      skipped.push({ unit, reason: 'unchanged' });
      continue;
    }
    bumps.push({ unit, from: currentVersion, to: bumpPatch(currentVersion) });
  }

  return { bumps, skipped };
}

// ---- repository discovery and CLI ------------------------------------------

function walk(dir: string, found: string[], root: string): void {
  for (const entry of readdirSync(path.join(root, dir))) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const rel = path.posix.join(dir, entry);
    if (statSync(path.join(root, rel)).isDirectory()) walk(rel, found, root);
    else found.push(rel);
  }
}

export function discoverUnits(root: string): Unit[] {
  const units: Unit[] = [];

  for (const file of readdirSync(path.join(root, 'agents')).sort()) {
    if (!file.endsWith('.yaml')) continue;
    const rel = `agents/${file}`;
    units.push({ kind: 'agent', versionFile: rel, scope: [rel] });
  }

  const skillFiles: string[] = [];
  walk('skills', skillFiles, root);
  for (const file of skillFiles.sort()) {
    const base = path.posix.basename(file);
    const dir = path.posix.dirname(file);
    if (base === 'tool.json') {
      units.push({ kind: 'tool', versionFile: file, scope: [dir] });
    } else if (base === 'SKILL.md' && dir.split('/').length === 2) {
      units.push({ kind: 'bundle', versionFile: file, scope: [file] });
    }
  }
  return units;
}

function gitReader(root: string): GitReader {
  const git = (args: string[]): string =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return {
    changedFiles: (ref, scope) =>
      git(['diff', '--name-only', ref, '--', ...scope]).split('\n').filter(Boolean),
    showAtRef: (ref, file) => {
      try {
        return execFileSync('git', ['-C', root, 'show', `${ref}:${file}`], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return null;
      }
    },
    readCurrent: (file) => readFileSync(path.join(root, file), 'utf-8'),
  };
}

function latestReleaseTag(root: string): string {
  const out = execFileSync('git', ['-C', root, 'describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], {
    encoding: 'utf-8',
  }).trim();
  if (!out) throw new Error('no v* release tag found; pass --since <ref>');
  return out;
}

export function main(argv: string[]): number {
  const write = argv.includes('--write');
  const sinceIdx = argv.indexOf('--since');
  const root = path.resolve(import.meta.dirname, '..');
  const ref = sinceIdx >= 0 ? argv[sinceIdx + 1] : latestReleaseTag(root);
  if (!ref) {
    console.error('--since needs a ref');
    return 2;
  }

  const { bumps, skipped } = planBumps(discoverUnits(root), ref, gitReader(root));

  for (const { unit, from, to } of bumps) {
    console.log(`${unit.kind.padEnd(6)} ${unit.versionFile}  ${from} -> ${to}`);
    if (write) {
      const file = path.join(root, unit.versionFile);
      writeFileSync(file, setVersion(unit.kind, readFileSync(file, 'utf-8'), to));
    }
  }
  const handBumped = skipped.filter((s) => s.reason === 'already-bumped').length;
  console.log(
    `\n${bumps.length} ${write ? 'bumped' : 'to bump (dry run; pass --write to apply)'} ` +
      `since ${ref}; ${handBumped} already bumped by hand; ` +
      `${skipped.filter((s) => s.reason === 'unchanged').length} unchanged.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
