// scripts/changelog-assemble.ts
//
// Merges the per-PR changelog fragments in `changes/` into CHANGELOG.md.
//
// Why fragments: every PR used to edit `## [Unreleased]` in CHANGELOG.md, which produced
// a changelog-only commit per PR and add/add merge conflicts between parallel PRs. Now each
// PR adds one file, `changes/<branch-name>.md`, so two PRs never touch the same file.
// This script folds them back into CHANGELOG.md at release time.
//
// A fragment holds the same `### Added` / `### Fixed` / ... headings and bullets the
// changelog uses. See changes/README.md for the format.
//
// Behavior:
//   - Existing `## [Unreleased]` content is preserved and merged with the fragments.
//   - Bullets are grouped under one heading per section, in a stable order
//     (Added, Changed, Fixed, Removed, Security; unknown headings last).
//   - Fragment bullets come first (newest-on-top, matching the existing file), fragments
//     in filename order, each fragment's bullets in file order.
//   - Without --version the merged result stays under `## [Unreleased]`.
//   - With --version/--name (and optionally --date) the merged result moves under a new
//     `## [X.Y.Z] — YYYY-MM-DD — "Name"` heading and `## [Unreleased]` is left empty.
//     The character blockquote and the condensing of bullets stay manual (release skill).
//   - Fragments are deleted after a successful write. --dry-run writes and deletes nothing.
//
// Run: pnpm changelog:assemble [--version X.Y.Z --name "Character Name" [--date YYYY-MM-DD]] [--dry-run]

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Section headings a fragment may use, in the order they are written to CHANGELOG.md. */
export const SECTION_ORDER = ['Added', 'Changed', 'Fixed', 'Removed', 'Security'] as const;

/** Hard cap on words after the em-dash in a bullet (CLAUDE.md, "Changelog fragments"). */
export const MAX_BULLET_WORDS = 15;

/** Files in `changes/` that are not fragments. */
const NON_FRAGMENT_FILES = new Set(['README.md']);

const UNRELEASED_HEADING = '## [Unreleased]';
const RELEASE_HEADING_PREFIX = '## [';

export interface Fragment {
  /** File name, e.g. `fix-thing.md`. */
  name: string;
  content: string;
}

export interface ReleaseHeading {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  /** Character name, without quotes. */
  name: string;
}

/** Items per section heading, in first-seen order. Each item is one bullet's lines. */
export type Sections = Map<string, string[][]>;

interface ParsedBlock {
  sections: Sections;
  /** Non-blank lines found before the first `###` heading. */
  stray: string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Splits markdown into `### Heading` sections of bullet items. A bullet's continuation
 * lines (anything non-blank that is not a heading or a new bullet) stay with the bullet.
 * Repeated headings are merged — the existing Unreleased block has some.
 */
export function parseSections(markdown: string): ParsedBlock {
  const sections: Sections = new Map();
  const stray: string[] = [];
  let current: string[][] | null = null;
  let item: string[] | null = null;

  for (const line of markdown.split('\n')) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const title = heading[1] as string;
      current = sections.get(title) ?? [];
      sections.set(title, current);
      item = null;
      continue;
    }
    if (line.trim() === '') {
      item = null;
      continue;
    }
    if (current === null) {
      stray.push(line);
      continue;
    }
    if (line.startsWith('- ')) {
      item = [line];
      current.push(item);
    } else if (item) {
      item.push(line);
    } else {
      // Non-bullet text after a blank line inside a section: keep it as its own item so
      // nothing is silently dropped.
      item = [line];
      current.push(item);
    }
  }
  return { sections, stray };
}

/**
 * Words after the em-dash, not counting a trailing `(#123)` / `(#123, #456)` reference or
 * tokens with no letter or digit (arrows, dashes).
 */
export function countBulletWords(bullet: string): number {
  const dash = bullet.indexOf(' — ');
  if (dash === -1) return 0;
  const body = bullet.slice(dash + 3).replace(/\s*\((?:#\d+(?:,\s*)?)+\)\s*$/, '');
  return body.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/**
 * Returns every problem found in a fragment (empty array means valid). Rules:
 *  - only `### <Added|Changed|Fixed|Removed|Security>` headings, no other heading levels
 *  - no text outside a section, no empty section, at least one bullet overall
 *  - every bullet is a single line shaped `- **Name** — description`
 *  - at most MAX_BULLET_WORDS words after the em-dash
 */
export function validateFragment(content: string): string[] {
  const problems: string[] = [];
  const { sections, stray } = parseSections(content);

  for (const line of stray) {
    problems.push(`text outside a "### Section": "${line.trim()}"`);
  }
  for (const line of content.split('\n')) {
    if (/^#{1,2}\s/.test(line) || /^#{4,}\s/.test(line)) {
      problems.push(`only "### Section" headings are allowed, found "${line.trim()}"`);
    }
  }
  if (sections.size === 0 && stray.length === 0) {
    problems.push('fragment has no sections (expected e.g. "### Fixed" followed by bullets)');
  }

  for (const [title, items] of sections) {
    if (!(SECTION_ORDER as readonly string[]).includes(title)) {
      problems.push(`unknown section "### ${title}" (allowed: ${SECTION_ORDER.join(', ')})`);
    }
    if (items.length === 0) {
      problems.push(`section "### ${title}" has no bullets`);
    }
    for (const lines of items) {
      const first = lines[0] as string;
      if (lines.length > 1) {
        problems.push(`bullet must be a single line: "${first.slice(0, 60)}"`);
        continue;
      }
      if (!/^- \*\*.+?\*\* — \S/.test(first)) {
        problems.push(`bullet must look like "- **Name** — description": "${first.slice(0, 60)}"`);
        continue;
      }
      const words = countBulletWords(first);
      if (words > MAX_BULLET_WORDS) {
        problems.push(
          `bullet has ${words} words after the em-dash (max ${MAX_BULLET_WORDS}): "${first.slice(0, 60)}"`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function sectionRank(title: string): number {
  const index = (SECTION_ORDER as readonly string[]).indexOf(title);
  return index === -1 ? SECTION_ORDER.length : index;
}

function renderSections(sections: Sections): string {
  const titles = [...sections.keys()].sort((a, b) => sectionRank(a) - sectionRank(b));
  const blocks: string[] = [];
  for (const title of titles) {
    const items = sections.get(title) ?? [];
    if (items.length === 0) continue;
    blocks.push(`### ${title}\n\n${items.map((lines) => lines.join('\n')).join('\n')}\n`);
  }
  return blocks.join('\n');
}

export function formatReleaseHeading(release: ReleaseHeading): string {
  return `## [${release.version}] — ${release.date} — "${release.name}"`;
}

export interface AssembleResult {
  /** The full new CHANGELOG.md text. */
  changelog: string;
  /** Just the section that was written (the Unreleased block, or the new release block). */
  section: string;
  /** Number of bullets taken from fragments. */
  fragmentBullets: number;
}

/**
 * Pure assembly: returns the new changelog text. Throws on an invalid fragment, a missing
 * `## [Unreleased]` heading, stray text in the Unreleased block, or a release heading for
 * a version that already exists. Nothing is written here.
 */
export function assemble(
  changelog: string,
  fragments: Fragment[],
  release?: ReleaseHeading,
): AssembleResult {
  const problems: string[] = [];
  for (const fragment of fragments) {
    for (const problem of validateFragment(fragment.content)) {
      problems.push(`${fragment.name}: ${problem}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid changelog fragment(s):\n  ${problems.join('\n  ')}`);
  }

  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.trim() === UNRELEASED_HEADING);
  if (start === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" heading`);
  let end = lines.findIndex((line, i) => i > start && line.startsWith(RELEASE_HEADING_PREFIX));
  if (end === -1) end = lines.length;

  if (release) {
    const existing = `${RELEASE_HEADING_PREFIX}${release.version}]`;
    if (lines.some((line) => line.startsWith(existing))) {
      throw new Error(`CHANGELOG.md already has a heading for ${release.version}`);
    }
  }

  const unreleased = parseSections(lines.slice(start + 1, end).join('\n'));
  if (unreleased.stray.length > 0) {
    throw new Error(
      `"${UNRELEASED_HEADING}" has text outside any "### Section" and would be lost:\n  ${unreleased.stray.join('\n  ')}`,
    );
  }

  // Fragments first (newest-on-top), in filename order, then what was already there.
  const merged: Sections = new Map();
  let fragmentBullets = 0;
  const ordered = [...fragments].sort((a, b) => a.name.localeCompare(b.name));
  for (const fragment of ordered) {
    for (const [title, items] of parseSections(fragment.content).sections) {
      merged.set(title, [...(merged.get(title) ?? []), ...items]);
      fragmentBullets += items.length;
    }
  }
  for (const [title, items] of unreleased.sections) {
    merged.set(title, [...(merged.get(title) ?? []), ...items]);
  }

  const body = renderSections(merged);
  const before = lines.slice(0, start).join('\n');
  const after = lines.slice(end).join('\n');

  let section: string;
  let replacement: string;
  if (release) {
    section = `${formatReleaseHeading(release)}\n\n${body}`;
    replacement = `${UNRELEASED_HEADING}\n\n${section}`;
  } else {
    section = `${UNRELEASED_HEADING}\n\n${body}`;
    replacement = section;
  }

  // `after` starts at the next release heading (or is empty at end of file). The rendered
  // body already ends with a blank line, so the blocks join without extra padding.
  const tail = after === '' ? '' : `\n${after}`;
  const text = `${before}\n${replacement.replace(/\n+$/, '\n')}${tail}`;
  return { changelog: text, section, fragmentBullets };
}

// ---------------------------------------------------------------------------
// Filesystem + CLI
// ---------------------------------------------------------------------------

export function listFragmentFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md') && !NON_FRAGMENT_FILES.has(file))
    .sort();
}

export interface CliOptions {
  root: string;
  dryRun: boolean;
  version?: string;
  date?: string;
  name?: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { root: resolve(import.meta.dirname, '..'), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--version') options.version = value();
    else if (arg === '--date') options.date = value();
    else if (arg === '--name') options.name = value();
    else if (arg === '--root') options.root = resolve(value());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if ((options.date || options.name) && !options.version) {
    throw new Error('--date and --name only apply together with --version');
  }
  if (options.version && !options.name) {
    throw new Error('--version needs --name "Character Name"');
  }
  if (options.version && !/^\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error(`--version must look like X.Y.Z, got "${options.version}"`);
  }
  if (options.date && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error(`--date must look like YYYY-MM-DD, got "${options.date}"`);
  }
  return options;
}

export interface RunResult {
  fragmentFiles: string[];
  section: string;
  written: boolean;
}

export function run(options: CliOptions): RunResult {
  const changelogPath = join(options.root, 'CHANGELOG.md');
  const changesDir = join(options.root, 'changes');
  const fragmentFiles = listFragmentFiles(changesDir);
  const fragments = fragmentFiles.map((name) => ({
    name,
    content: readFileSync(join(changesDir, name), 'utf8'),
  }));

  const release: ReleaseHeading | undefined = options.version
    ? {
        version: options.version,
        date: options.date ?? new Date().toISOString().slice(0, 10),
        name: options.name as string,
      }
    : undefined;

  const result = assemble(readFileSync(changelogPath, 'utf8'), fragments, release);
  if (options.dryRun) return { fragmentFiles, section: result.section, written: false };

  writeFileSync(changelogPath, result.changelog);
  for (const name of fragmentFiles) unlinkSync(join(changesDir, name));
  return { fragmentFiles, section: result.section, written: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = run(options);
    const count = result.fragmentFiles.length;
    const target = options.version ? `${options.version} section` : 'Unreleased section';
    if (result.written) {
      process.stdout.write(
        `Merged ${count} fragment(s) into the ${target} of CHANGELOG.md and deleted them.\n`,
      );
    } else {
      process.stdout.write(
        `[dry-run] ${count} fragment(s): ${result.fragmentFiles.map((f) => basename(f)).join(', ') || '(none)'}\n` +
          `[dry-run] CHANGELOG.md and changes/ left untouched. The ${target} would be:\n\n${result.section}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
