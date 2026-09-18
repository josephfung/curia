import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Guard for #1483. `docs/wip/` is deliberately disposable: the release checklist prunes
// artifacts whose work has shipped. Durable files (source, specs, ADRs, migrations, dev
// guides) that cite one are therefore left pointing at nothing the moment it is pruned.
//
// That rot is silent and recurring. The #1483 audit found 26 dangling citations across 23
// locations; four of them were introduced *after* the issue was filed, when the v0.42 doc
// sync pruned a design memo that four durable files still referenced. Nothing failed.
//
// Two details this check exists to get right, because the issue's original hand-written
// grep got both wrong:
//
//   1. Both citation forms count. A prose mention is `docs/wip/<file>.md`; a markdown link
//      from inside `docs/` is relative — `[...](../wip/<file>.md)`. Matching only the
//      former missed four dangling links in spec 19 that had been broken for a month.
//   2. The scope is every durable tree, not a hand-listed few. `docs/dev/` was outside the
//      original grep and accumulated a dangling reference of its own.
//
// Directory-level mentions that name no file (`docs/wip/YYYY-MM-DD-<feature>-design.md` as
// a naming convention, "pruned from `docs/wip/`") are not references to anything and are
// not matched — only a citation resolving to a concrete `.md` filename is.

const REPO_ROOT = join(import.meta.dirname, '../..');
const WIP_DIR = join(REPO_ROOT, 'docs/wip');

/**
 * Trees whose files are durable — they outlive any single release and must never depend
 * on a `docs/wip/` artifact surviving.
 *
 * `CHANGELOG.md` and `CLAUDE.md` are deliberately absent: the changelog is a historical
 * record of prunes that already happened, and CLAUDE.md documents the `docs/wip/` naming
 * convention itself. Both mention the directory legitimately and neither names a file.
 */
const DURABLE_TREES = ['src', 'tests', 'skills', 'scripts', 'docs/specs', 'docs/adr', 'docs/dev'];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
// Every hand-written text format in the durable trees. `.sh` and `.py` are here because
// the durable trees really do contain them — the CI and docker test harnesses under
// `tests/`, and skill fixture scripts — and a comment in one can cite a design doc exactly
// like a comment in a `.ts` file can. Binary formats (`.pdf`) are excluded; they carry no
// hand-written citations. Keep this in sync with the extension census in
// `scans every text format present in the durable trees` below, which fails if a new
// format appears in the repo without being listed here.
const SCANNED_EXTENSION = /\.(?:[cm]?tsx?|js|mjs|cjs|sql|md|ya?ml|json|sh|py)$/;

/** Extensions deliberately not scanned, with the reason. Asserted against the repo below. */
const UNSCANNED_EXTENSIONS = new Set([
  'pdf', // binary
  'gitkeep', // empty placeholder
]);

/**
 * Both ways a durable file cites a WIP artifact, each capturing the bare filename:
 * the absolute-from-repo-root prose form, and the `../wip/` relative link markdown uses.
 *
 * Anchored on a trailing `.md` so directory-level mentions never match.
 */
const CITATION_PATTERNS = [/docs\/wip\/([\w.-]+\.md)/g, /\.\.\/wip\/([\w.-]+\.md)/g];

/**
 * This file, which is scanned like any other under `tests/`. Its fixtures below are
 * deliberately-dangling citations, so it must exempt itself or it always fails.
 */
const SELF = relative(REPO_ROOT, join(import.meta.dirname, 'wip-reference-integrity.test.ts'))
  .split(sep)
  .join('/');

interface Citation {
  file: string;
  line: number;
  doc: string;
}

/** Every scannable file under `dir`, recursively. */
function collectFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(full, out);
    } else if (SCANNED_EXTENSION.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Every file under `dir` regardless of extension — the census the guard is checked against. */
function collectAllFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectAllFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Every `docs/wip/*.md` citation in the durable trees, with its source location. */
function collectCitations(): Citation[] {
  const citations: Citation[] = [];
  for (const tree of DURABLE_TREES) {
    for (const file of collectFiles(join(REPO_ROOT, tree))) {
      if (relative(REPO_ROOT, file).split(sep).join('/') === SELF) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, index) => {
        for (const pattern of CITATION_PATTERNS) {
          // Shared global regexes carry lastIndex between uses; reset per line.
          pattern.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(text)) !== null) {
            citations.push({
              file: relative(REPO_ROOT, file).split(sep).join('/'),
              line: index + 1,
              doc: match[1]!,
            });
          }
        }
      });
    }
  }
  return citations;
}

describe('wip reference integrity', () => {
  it('every docs/wip reference from a durable file resolves to a doc that exists', () => {
    const dangling = collectCitations()
      .filter((c) => !existsSync(join(WIP_DIR, c.doc)))
      .map((c) => `${c.file}:${c.line} → docs/wip/${c.doc}`);

    expect(
      dangling,
      `these durable files cite docs/wip artifacts that no longer exist. docs/wip/ is ` +
        `pruned every release, so a durable file must never depend on one: repoint each ` +
        `reference at the spec or ADR that now owns the content, or drop the clause.\n  ` +
        dangling.join('\n  '),
    ).toEqual([]);
  });

  it('scans the durable trees it claims to', () => {
    // Without this the assertion above passes vacuously if a tree is renamed away or the
    // extension filter stops matching — the same silent-green failure #1483 was about.
    for (const tree of DURABLE_TREES) {
      expect(
        existsSync(join(REPO_ROOT, tree)),
        `durable tree "${tree}" does not exist — update DURABLE_TREES rather than ` +
          `letting this check quietly cover less than it claims`,
      ).toBe(true);
      expect(collectFiles(join(REPO_ROOT, tree)).length, `no files scanned under ${tree}`)
        .toBeGreaterThan(0);
    }
  });

  it('scans every text format present in the durable trees', () => {
    // The first version of this guard listed only the formats the #1483 audit happened to
    // touch, silently skipping the `.sh` and `.py` files that live under tests/. A guard
    // against omissions that quietly omits is worse than none, so rather than trusting the
    // extension list to stay complete, derive the real census and require every format to
    // be either scanned or explicitly waived.
    const present = new Set<string>();
    for (const tree of DURABLE_TREES) {
      for (const file of collectAllFiles(join(REPO_ROOT, tree))) {
        const ext = file.split('.').pop();
        if (ext && ext !== file) present.add(ext.toLowerCase());
      }
    }
    expect(present.size, 'no extensions found — the census itself is broken').toBeGreaterThan(0);

    const unaccounted = [...present]
      .filter((ext) => !SCANNED_EXTENSION.test(`f.${ext}`) && !UNSCANNED_EXTENSIONS.has(ext))
      .sort();

    expect(
      unaccounted,
      `these formats exist in the durable trees but are neither scanned nor listed as ` +
        `deliberately unscanned, so a docs/wip citation in one would slip through: ` +
        `${unaccounted.join(', ')}. Add each to SCANNED_EXTENSION, or to ` +
        `UNSCANNED_EXTENSIONS with the reason.`,
    ).toEqual([]);
  });

  it('matches both citation forms and ignores directory-only mentions', () => {
    // Pins the two bugs in the original hand-written grep (#1483): it matched only the
    // `docs/wip/` form, and it would have tripped over prose naming the directory alone.
    const scan = (text: string): string[] =>
      CITATION_PATTERNS.flatMap((pattern) => {
        pattern.lastIndex = 0;
        return [...text.matchAll(pattern)].map((m) => m[1]!);
      });

    expect(scan('// See: docs/wip/2026-05-12-context-budget-design.md')).toEqual([
      '2026-05-12-context-budget-design.md',
    ]);
    expect(scan('[design](../wip/2026-06-01-tasks-and-backlog-design.md)')).toEqual([
      '2026-06-01-tasks-and-backlog-design.md',
    ]);
    expect(scan('All WIP artifacts go directly in `docs/wip/`.')).toEqual([]);
    expect(scan('shipped design memos pruned from `docs/wip/`. (#1285)')).toEqual([]);
  });
});
