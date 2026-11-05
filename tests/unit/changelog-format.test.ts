// changelog-format.test.ts — each release block in CHANGELOG.md has each `### Section` once.
//
// PRs no longer edit CHANGELOG.md: they add `changes/<branch>.md` fragments, which
// tests/unit/changelog-fragments.test.ts validates (sections, bullet shape, the
// 15-word cap), and `pnpm changelog:assemble` writes one heading per section when
// it cuts a release. The release PR then condenses the bullets by hand, and that hand
// edit is the one place a repeated heading can still appear. "Merge this into the
// existing `### Security` section" was a recurring CodeRabbit finding before the
// fragment flow (review-mining, 2026-11; docs/dev/review-checklist.md).
//
// Not checked here, on purpose:
// - `## [Unreleased]`: legacy pre-fragment bullets still sit there, including a
//   repeated `### Security`, and the assembler merges repeated headings at release.
// - section names and the word cap: older releases use other headings (e.g.
//   "Documentation", "Breaking Changes") and longer bullets, and both rules are
//   enforced on fragments, where new entries are written.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');

/** Every `### Heading` that appears more than once inside one `## [x.y.z]` release block. */
function repeatedReleaseHeadings(changelog: string): string[] {
  const problems: string[] = [];
  let release: string | null = null;
  let seen = new Set<string>();
  for (const line of changelog.split('\n')) {
    if (line.startsWith('## ')) {
      release = line.startsWith('## [Unreleased]') ? null : line.slice(3).trim();
      seen = new Set();
      continue;
    }
    const heading = /^### (.+?)\s*$/.exec(line);
    if (!heading || release === null) continue;
    if (seen.has(heading[1]!)) problems.push(`${release}: "### ${heading[1]}" appears twice; merge the two sections`);
    seen.add(heading[1]!);
  }
  return problems;
}

describe('CHANGELOG.md release blocks', () => {
  it('have each section heading at most once', () => {
    expect(repeatedReleaseHeadings(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'))).toEqual([]);
  });

  it('flags a repeat inside a release and ignores Unreleased and other releases', () => {
    const sample = [
      '## [Unreleased]',
      '### Security',
      '### Security',
      '## [0.2.0] — 2026-02-01 — "B"',
      '### Fixed',
      '### Security',
      '### Fixed',
      '## [0.1.0] — 2026-01-01 — "A"',
      '### Fixed',
    ].join('\n');
    expect(repeatedReleaseHeadings(sample)).toEqual([
      '[0.2.0] — 2026-02-01 — "B": "### Fixed" appears twice; merge the two sections',
    ]);
  });
});
