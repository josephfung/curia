// changelog-format.test.ts — CHANGELOG.md's [Unreleased] section follows CLAUDE.md's rules.
//
// CLAUDE.md caps each bullet at 15 words after the em-dash and lists the allowed
// sections. Both rules were enforced only by review: a 2026-08..11 mining of
// CodeRabbit findings (docs/dev/review-checklist.md) found changelog findings on
// one PR in ten that got any, most of them "shorten this bullet" or "merge this
// into the existing section". Each cost a review round; this check costs nothing.
//
// Only [Unreleased] is checked. Released sections are history, and the release
// PR condenses them by hand.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');
const SECTIONS = new Set(['Added', 'Changed', 'Fixed', 'Removed', 'Security']);
const MAX_WORDS = 15;

/** The [Unreleased] section's lines, heading excluded. */
function unreleasedLines(changelog: string): string[] {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith('## [Unreleased]'));
  if (start < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" heading');
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/**
 * Words after the em-dash, not counting a trailing reference such as "(#2192)",
 * "(#2192, spec 14)" or "(curia-deploy#324)". Null when the bullet has no
 * `**name** — ` lead.
 */
function wordsAfterDash(bullet: string): number | null {
  const lead = /^- \*\*.+?\*\* — /.exec(bullet);
  if (!lead) return null;
  const description = bullet
    .slice(lead[0].length)
    .replace(/\s*\([^()]*(?:#\d+|spec \d+)[^()]*\)\.?\s*$/, '')
    .trim();
  return description.split(/\s+/).filter(Boolean).length;
}

function changelogProblems(changelog: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const line of unreleasedLines(changelog)) {
    const heading = /^### (.+?)\s*$/.exec(line);
    if (heading) {
      const name = heading[1]!;
      if (!SECTIONS.has(name)) problems.push(`unknown section "### ${name}" (use ${[...SECTIONS].join(', ')})`);
      if (seen.has(name)) problems.push(`second "### ${name}" section; add the bullet to the existing one`);
      seen.add(name);
      continue;
    }
    if (!line.startsWith('- ')) continue;
    const words = wordsAfterDash(line);
    if (words === null) problems.push(`bullet does not start with "- **name** — ": ${line.slice(0, 80)}`);
    else if (words > MAX_WORDS) problems.push(`${words} words after the em-dash (max ${MAX_WORDS}): ${line.slice(0, 80)}`);
  }
  return problems;
}

describe('CHANGELOG.md [Unreleased]', () => {
  it('follows the CLAUDE.md bullet and section rules', () => {
    expect(changelogProblems(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'))).toEqual([]);
  });

  it('counts words after the dash and ignores a trailing reference', () => {
    expect(wordsAfterDash('- **`x`** — one two three. (#12, spec 14)')).toBe(3);
    expect(wordsAfterDash('- **x** — one two (curia-deploy#324)')).toBe(2);
    expect(wordsAfterDash('- **x** — keeps (parenthetical words) inside the count.')).toBe(6);
    expect(wordsAfterDash('- plain bullet')).toBeNull();
  });

  it('flags a long bullet, a repeated section and an unknown section', () => {
    const sample = [
      '## [Unreleased]',
      '### Fixed',
      `- **long** — ${'word '.repeat(16).trim()}. (#1)`,
      '### Security',
      '- **ok** — fine. (#2)',
      '### Security',
      '### Misc',
      '## [0.1.0] — 2026-01-01',
      '### Fixed',
      `- **old** — ${'word '.repeat(30).trim()}`,
    ].join('\n');
    const problems = changelogProblems(sample);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('16 words');
    expect(problems[1]).toContain('second "### Security"');
    expect(problems[2]).toContain('unknown section "### Misc"');
  });
});
