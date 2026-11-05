// scripts/changelog-assemble.test.ts
//
// Tests for the changelog fragment assembler. Pure-function tests run on in-memory
// strings; the CLI-level tests (`run`) use a throwaway directory.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assemble,
  countBulletWords,
  listFragmentFiles,
  parseArgs,
  parseSections,
  run,
  validateFragment,
} from './changelog-assemble.js';

const CHANGELOG = `# Changelog

Intro text.

---

## [Unreleased]

### Added

- **Old thing** — already unreleased. (#1)

### Security

- **Old hardening** — fixed a hole. (#2)

### Fixed

- **Old fix** — repaired. (#3)

### Security

- **Second security block** — duplicate heading in the file. (#4)

## [1.0.0] — 2026-01-01 — "Earlier"

### Added

- **Shipped** — in 1.0.0. (#0)

[1.0.0]: https://example.invalid/compare
`;

const FRAG_A = `### Fixed

- **Alpha fix** — fixes alpha. (#10)

### Added

- **Alpha feature** — adds alpha. (#10)
`;

const FRAG_B = `### Changed

- **Beta change** — changes beta. (#11)

### Fixed

- **Beta fix** — fixes beta. (#11)
`;

describe('countBulletWords', () => {
  it('counts words after the em-dash and ignores a trailing PR reference', () => {
    expect(countBulletWords('- **X** — one two three. (#12)')).toBe(3);
    expect(countBulletWords('- **X** — one two three. (#12, #13)')).toBe(3);
  });

  it('ignores symbol-only tokens such as arrows', () => {
    expect(countBulletWords('- **X** — Memory → Secrets lists it.')).toBe(4);
  });

  it('returns 0 when there is no em-dash', () => {
    expect(countBulletWords('- **X** no dash here')).toBe(0);
  });
});

describe('parseSections', () => {
  it('merges repeated headings and keeps continuation lines with their bullet', () => {
    const { sections, stray } = parseSections(
      '### Added\n\n- one\n  continued\n- two\n\n### Added\n\n- three\n',
    );
    expect(stray).toEqual([]);
    expect(sections.get('Added')).toEqual([['- one', '  continued'], ['- two'], ['- three']]);
  });

  it('reports text before the first heading as stray', () => {
    expect(parseSections('hello\n### Added\n- a\n').stray).toEqual(['hello']);
  });
});

describe('validateFragment', () => {
  it('accepts a well-formed fragment', () => {
    expect(validateFragment(FRAG_A)).toEqual([]);
  });

  it('rejects an unknown section heading', () => {
    const problems = validateFragment('### Misc\n\n- **X** — y. (#1)\n');
    expect(problems.join('\n')).toMatch(/unknown section "### Misc"/);
  });

  it('rejects other heading levels, such as an Unreleased heading', () => {
    const problems = validateFragment('## [Unreleased]\n\n### Added\n\n- **X** — y.\n');
    expect(problems.join('\n')).toMatch(/only "### Section" headings/);
  });

  it('rejects a bullet over the word cap but accepts exactly the cap', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => `w${i}`).join(' ');
    const sixteen = `${fifteen} extra`;
    expect(validateFragment(`### Added\n\n- **X** — ${fifteen}. (#1)\n`)).toEqual([]);
    const problems = validateFragment(`### Added\n\n- **X** — ${sixteen}. (#1)\n`);
    expect(problems.join('\n')).toMatch(/16 words after the em-dash \(max 15\)/);
  });

  it('rejects a bullet without the bold-name em-dash shape', () => {
    expect(validateFragment('### Added\n\n- plain bullet\n').join('\n')).toMatch(
      /bullet must look like/,
    );
  });

  it('rejects multi-line bullets, empty sections and an empty file', () => {
    expect(validateFragment('### Added\n\n- **X** — y.\n  more\n').join('\n')).toMatch(
      /single line/,
    );
    expect(validateFragment('### Added\n\n').join('\n')).toMatch(/no bullets/);
    expect(validateFragment('').join('\n')).toMatch(/no sections/);
  });

  it('rejects text outside a section', () => {
    expect(validateFragment('Some prose\n\n### Added\n\n- **X** — y.\n').join('\n')).toMatch(
      /outside a "### Section"/,
    );
  });
});

describe('assemble (stays under Unreleased)', () => {
  const frags = [
    { name: 'b-branch.md', content: FRAG_B },
    { name: 'a-branch.md', content: FRAG_A },
  ];

  it('groups by heading in stable order, fragments first, merging existing content', () => {
    const { changelog, fragmentBullets } = assemble(CHANGELOG, frags);
    expect(fragmentBullets).toBe(4);

    const unreleased = changelog.slice(
      changelog.indexOf('## [Unreleased]'),
      changelog.indexOf('## [1.0.0]'),
    );
    expect(unreleased).toBe(`## [Unreleased]

### Added

- **Alpha feature** — adds alpha. (#10)
- **Old thing** — already unreleased. (#1)

### Changed

- **Beta change** — changes beta. (#11)

### Fixed

- **Alpha fix** — fixes alpha. (#10)
- **Beta fix** — fixes beta. (#11)
- **Old fix** — repaired. (#3)

### Security

- **Old hardening** — fixed a hole. (#2)
- **Second security block** — duplicate heading in the file. (#4)

`);
    // Released history and the footer are untouched.
    expect(changelog).toContain('## [1.0.0] — 2026-01-01 — "Earlier"\n\n### Added\n\n- **Shipped**');
    expect(changelog.endsWith('[1.0.0]: https://example.invalid/compare\n')).toBe(true);
    expect(changelog.startsWith('# Changelog\n\nIntro text.\n\n---\n\n## [Unreleased]')).toBe(true);
  });

  it('is independent of the order fragments are passed in', () => {
    const one = assemble(CHANGELOG, frags).changelog;
    const two = assemble(CHANGELOG, [...frags].reverse()).changelog;
    expect(one).toBe(two);
  });

  it('is idempotent once there is nothing left to merge', () => {
    const once = assemble(CHANGELOG, frags).changelog;
    expect(assemble(once, []).changelog).toBe(once);
  });

  it('throws without writing when any fragment is invalid, naming the file', () => {
    expect(() =>
      assemble(CHANGELOG, [{ name: 'bad.md', content: '### Nope\n\n- **X** — y.\n' }]),
    ).toThrow(/bad\.md: unknown section "### Nope"/);
  });

  it('throws when Unreleased holds text that would be lost', () => {
    const odd = CHANGELOG.replace('## [Unreleased]\n', '## [Unreleased]\n\nstray prose\n');
    expect(() => assemble(odd, frags)).toThrow(/would be lost/);
  });

  it('throws when the changelog has no Unreleased heading', () => {
    expect(() => assemble('# Changelog\n', frags)).toThrow(/no "## \[Unreleased\]" heading/);
  });

  it('works when Unreleased is the last block in the file', () => {
    const { changelog } = assemble('# Changelog\n\n## [Unreleased]\n', [
      { name: 'a.md', content: FRAG_A },
    ]);
    expect(changelog).toBe(
      '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- **Alpha feature** — adds alpha. (#10)\n\n### Fixed\n\n- **Alpha fix** — fixes alpha. (#10)\n',
    );
  });
});

describe('assemble (release heading)', () => {
  const release = { version: '1.1.0', date: '2026-02-02', name: 'Marvin' };

  it('moves everything under the release heading and leaves Unreleased empty', () => {
    const { changelog } = assemble(CHANGELOG, [{ name: 'a.md', content: FRAG_A }], release);
    const lines = changelog.split('\n');
    const unreleasedAt = lines.indexOf('## [Unreleased]');
    expect(lines.slice(unreleasedAt, unreleasedAt + 3)).toEqual([
      '## [Unreleased]',
      '',
      '## [1.1.0] — 2026-02-02 — "Marvin"',
    ]);
    const block = changelog.slice(
      changelog.indexOf('## [1.1.0]'),
      changelog.indexOf('## [1.0.0]'),
    );
    expect(block).toContain('- **Alpha feature**');
    expect(block).toContain('- **Old thing**');
    expect(block).toContain('- **Second security block**');
    expect(block.match(/### Security/g)).toHaveLength(1);
  });

  it('refuses a version that already has a heading', () => {
    expect(() =>
      assemble(CHANGELOG, [], { version: '1.0.0', date: '2026-02-02', name: 'Dup' }),
    ).toThrow(/already has a heading for 1\.0\.0/);
  });
});

describe('parseArgs', () => {
  it('parses flags', () => {
    const options = parseArgs(['--dry-run', '--version', '1.2.3', '--name', 'Marvin', '--date', '2026-01-02']);
    expect(options).toMatchObject({ dryRun: true, version: '1.2.3', name: 'Marvin', date: '2026-01-02' });
  });

  it('rejects incomplete or malformed release flags and unknown arguments', () => {
    expect(() => parseArgs(['--version', '1.2.3'])).toThrow(/--name/);
    expect(() => parseArgs(['--name', 'X'])).toThrow(/only apply together/);
    expect(() => parseArgs(['--version', '1.2', '--name', 'X'])).toThrow(/X\.Y\.Z/);
    expect(() => parseArgs(['--date', '2026-01-01', '--version', '1.2.3', '--name', 'X'])).not.toThrow();
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});

describe('run (filesystem)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): string {
    const root = mkdtempSync(join(tmpdir(), 'changelog-assemble-'));
    dirs.push(root);
    mkdirSync(join(root, 'changes'));
    writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG);
    writeFileSync(join(root, 'changes', 'README.md'), '# not a fragment\n');
    writeFileSync(join(root, 'changes', 'feat-a.md'), FRAG_A);
    writeFileSync(join(root, 'changes', 'fix-b.md'), FRAG_B);
    return root;
  }

  it('lists fragments but not the README', () => {
    expect(listFragmentFiles(join(setup(), 'changes'))).toEqual(['feat-a.md', 'fix-b.md']);
    expect(listFragmentFiles(join(tmpdir(), 'does-not-exist-xyz'))).toEqual([]);
  });

  it('dry-run reports the result and changes nothing', () => {
    const root = setup();
    const result = run({ root, dryRun: true });
    expect(result.written).toBe(false);
    expect(result.section).toContain('**Alpha feature**');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(CHANGELOG);
    expect(existsSync(join(root, 'changes', 'feat-a.md'))).toBe(true);
  });

  it('writes the changelog and deletes fragments, keeping the README', () => {
    const root = setup();
    const result = run({ root, dryRun: false, version: '1.1.0', name: 'Marvin', date: '2026-02-02' });
    expect(result.written).toBe(true);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('## [1.1.0] — 2026-02-02 — "Marvin"');
    expect(existsSync(join(root, 'changes', 'feat-a.md'))).toBe(false);
    expect(existsSync(join(root, 'changes', 'fix-b.md'))).toBe(false);
    expect(existsSync(join(root, 'changes', 'README.md'))).toBe(true);
  });

  it('leaves everything in place when a fragment is invalid', () => {
    const root = setup();
    writeFileSync(join(root, 'changes', 'zz-bad.md'), '### Wrong\n\n- **X** — y.\n');
    expect(() => run({ root, dryRun: false })).toThrow(/zz-bad\.md/);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(CHANGELOG);
    expect(existsSync(join(root, 'changes', 'feat-a.md'))).toBe(true);
  });
});
