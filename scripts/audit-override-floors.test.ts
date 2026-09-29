// scripts/audit-override-floors.test.ts
//
// Tests for the override-floor auditor (#1934).
//
// Every test runs OFFLINE against an injected PackageDataSource. The live network
// path is exercised by the scheduled CI job, not here: a test that hit the real
// advisory DB would change verdict whenever upstream publishes, which is precisely
// the moving target this script exists to watch. Fixtures below are trimmed copies
// of real API responses (see the recorded ranges in each fixture's comment).
//
// Behaviors under test:
//   1. Override parsing: plain, scoped, targeted (parent>child), compound, caret
//   2. Unparseable specifiers fail rather than being skipped
//   3. Trap 1 — "newest patched version" is not a safe floor (undici >=7.29.1)
//   4. Trap 2 — a floor on one major does not constrain another (undici 7.x vs 8.x)
//   5. Trap 3 — upstream repo advisories are consulted, not just the global DB
//   6. Safe-floor arithmetic stays inside a compound range's upper bound
//   7. Allowlist: id-specific, requires a reason, does not blanket-skip a package
//   8. Loud failure on API error, and on an empty advisory list that was not declared
//   9. Prereleases are excluded from the admitted set

import { describe, it, expect } from 'vitest';
import semver from 'semver';
import {
  parseOverrides,
  parseFloorRange,
  overrideSubject,
  normalizeAdvisoryRange,
  toAdvisoryRecords,
  auditOverrideFloors,
  formatReport,
  type AdvisoryRecord,
  type PackageDataSource,
  type AuditPolicy,
  type RawAdvisory,
} from './audit-override-floors.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function adv(
  ghsaId: string,
  severity: AdvisoryRecord['severity'],
  ranges: string[],
  source: AdvisoryRecord['source'] = 'global',
): AdvisoryRecord {
  return { ghsaId, severity, ranges, source };
}

interface FakeSourceSpec {
  versions?: Record<string, string[]>;
  repos?: Record<string, string | null>;
  global?: Record<string, AdvisoryRecord[]>;
  /** repo slug -> package name -> that package's advisories on that repo. */
  repoAdvisories?: Record<string, Record<string, AdvisoryRecord[]>>;
  /** Package (or repo slug) name -> error message the call should throw. */
  fail?: Record<string, string>;
}

function fakeSource(spec: FakeSourceSpec): PackageDataSource {
  const boom = (key: string): void => {
    const message = spec.fail?.[key];
    if (message) throw new Error(message);
  };
  return {
    async listVersions(pkg) {
      boom(pkg);
      const versions = spec.versions?.[pkg];
      if (!versions) throw new Error(`fixture gap: no versions for ${pkg}`);
      return versions;
    },
    async upstreamRepo(pkg) {
      boom(pkg);
      return spec.repos?.[pkg] ?? null;
    },
    async globalAdvisories(pkg) {
      boom(pkg);
      return spec.global?.[pkg] ?? [];
    },
    async repoAdvisories(slug, pkg) {
      boom(slug);
      // Keyed by slug AND package, mirroring the live source's contract: a monorepo's
      // advisory list covers many packages and only the requested one may come back.
      return spec.repoAdvisories?.[slug]?.[pkg] ?? [];
    },
  };
}

const NO_POLICY: AuditPolicy = { allowlist: [], noAdvisoryExpected: [] };

function yamlWith(overrides: string): string {
  return `packages:\n  - 'apps/*'\n\noverrides:\n${overrides}\n`;
}

// Recorded from registry.npmjs.org. Deliberately UNSORTED and with a prerelease,
// because the registry returns keys in lexicographic order ("8.10.1" sorts before
// "8.2.0") — the auditor must semver-sort rather than trust this order.
const UNDICI_VERSIONS = [
  '7.28.0',
  '7.29.0',
  '7.29.1',
  '8.0.0',
  '8.1.0',
  '8.10.0',
  '8.10.1',
  '8.10.2',
  '8.11.0',
  '8.2.0',
  '8.5.0',
  '8.9.0',
  '8.12.0-rc.1',
];

// Recorded from /advisories?ecosystem=npm&affects=undici. The last-closing 8.x
// range (< 8.10.2) is what sets the safe floor.
const UNDICI_ADVISORIES = [
  adv('GHSA-3wwx-pv8p-q78v', 'medium', [
    '>= 7.28.0, < 7.29.1',
    '>= 8.1.0, < 8.10.2',
  ]),
  adv('GHSA-4cwx-7wf7-3272', 'high', ['>= 7.0.0, < 7.29.0', '>= 8.0.0, < 8.9.0']),
  adv('GHSA-38rv-x7px-6hhq', 'high', ['>= 8.0.0, < 8.5.0']),
];

// ---------------------------------------------------------------------------
// 1. Override parsing
// ---------------------------------------------------------------------------

describe('parseOverrides', () => {
  it('extracts plain, scoped, targeted, compound and caret entries', () => {
    const yaml = yamlWith(
      [
        `  hono: '>=4.13.5'`,
        `  uuid: '^11.1.1'`,
        `  '@opentelemetry/core': '>=2.8.0'`,
        `  'onnxruntime-web>protobufjs': '>=7.6.5 <8'`,
        `  'promptfoo>js-yaml': '>=5.2.2'`,
      ].join('\n'),
    );

    expect(parseOverrides(yaml)).toEqual([
      { key: 'hono', specifier: '>=4.13.5', subject: 'hono' },
      { key: 'uuid', specifier: '^11.1.1', subject: 'uuid' },
      {
        key: '@opentelemetry/core',
        specifier: '>=2.8.0',
        subject: '@opentelemetry/core',
      },
      {
        key: 'onnxruntime-web>protobufjs',
        specifier: '>=7.6.5 <8',
        subject: 'protobufjs',
      },
      { key: 'promptfoo>js-yaml', specifier: '>=5.2.2', subject: 'js-yaml' },
    ]);
  });

  it('throws when the overrides block is missing entirely', () => {
    expect(() => parseOverrides(`packages:\n  - 'apps/*'\n`)).toThrow(/no `overrides:`/);
  });
});

describe('overrideSubject', () => {
  it('takes the child of a targeted key, not the parent', () => {
    expect(overrideSubject('onnxruntime-web>protobufjs')).toBe('protobufjs');
  });

  it('strips a version suffix without eating a scope', () => {
    expect(overrideSubject('@hono/node-server')).toBe('@hono/node-server');
    expect(overrideSubject('promptfoo@1>@scope/child@2')).toBe('@scope/child');
    expect(overrideSubject('semver@7')).toBe('semver');
  });
});

describe('parseFloorRange', () => {
  it.each([
    ['>=4.13.5', '>=4.13.5'],
    ['>=7.6.5 <8', '>=7.6.5 <8.0.0-0'],
    ['^11.1.1', '>=11.1.1 <12.0.0-0'],
  ])('normalizes %s', (specifier, expected) => {
    expect(parseFloorRange(specifier)).toBe(expected);
  });

  it('throws rather than skipping an unparseable specifier', () => {
    expect(() => parseFloorRange('not-a-range')).toThrow(/cannot parse/i);
  });
});

// ---------------------------------------------------------------------------
// 1b. Advisory range normalization
//
// The global DB emits a normalized form (">= 8.0.0, < 8.10.2"). A project's OWN repo
// advisories are hand-authored and are not normalized at all — every string below was
// recorded verbatim from /repos/<owner>/<repo>/security-advisories. Getting one of
// these wrong in the permissive direction silently drops a real advisory, which is the
// exact failure this script exists to catch, so they are pinned here individually.
// ---------------------------------------------------------------------------

describe('normalizeAdvisoryRange', () => {
  it.each([
    // Global-DB form: comma is AND.
    ['>= 8.0.0, < 8.10.2', '>=8.0.0 <8.10.2'],
    ['>= 5.0.0, <=5.4.0', '>=5.0.0 <=5.4.0'],
    ['<= 10.7.0', '<=10.7.0'],
    ['< 4.1.5', '<4.1.5'],
    // Bare exact version (adm-zip GHSA-c6fg-446q-cg94).
    ['0.6.0', '0.6.0'],
    // `&&` as the AND separator (@opentelemetry/core GHSA-f8pq-3926-8gx5).
    ['>= 0.40.0 && < 0.41.2', '>=0.40.0 <0.41.2'],
    // `==` operator (protobufjs GHSA-xq3m-2v4x-88gg).
    ['==8.0.0', '8.0.0'],
    // A space inside the operator (@hono/node-server GHSA-rmxm-3fg6-px4f).
    ['> = 1.19.10 < 2.1.3', '>=1.19.10 <2.1.3'],
    // Semicolon-separated OR groups, where a bare version before an upper bound is
    // an implied lower bound (undici GHSA-rfgv-xxqx-mfg5).
    [
      '>= 6.7.0 < 6.28.1; 7.0.0 < 7.29.1; 8.0.0 < 8.10.2',
      '>=6.7.0 <6.28.1||>=7.0.0 <7.29.1||>=8.0.0 <8.10.2',
    ],
    // Leading bare upper bound, then implied-lower groups (undici GHSA-r53p-7pc4-xj5r).
    ['< 6.28.1; 7.0.0 < 7.29.1; 8.0.0 < 8.10.2', '<6.28.1||>=7.0.0 <7.29.1||>=8.0.0 <8.10.2'],
    // Hyphen ranges mixed with a bare upper bound (form-data GHSA-fjxv-7rqg-78g4).
    ['< 2.5.4 3.0.0 - 3.0.3 4.0.0 - 4.0.3', '<2.5.4||>=3.0.0 <=3.0.3||>=4.0.0 <=4.0.3'],
    // Semicolon then a bare exact version (find-my-way GHSA-rrr8-f88r-h8q6).
    ['< 8.2.2; 9.0.0', '<8.2.2||9.0.0'],
    // Whitespace-only separators across four majors (brace-expansion GHSA-mh99-v99m-4gvg).
    [
      '<1.1.17 >= 2.0.0 < 2.1.3 >= 3.0.0 < 3.0.3 4.0.0 - 5.0.7',
      '<1.1.17||>=2.0.0 <2.1.3||>=3.0.0 <3.0.3||>=4.0.0 <=5.0.7',
    ],
    // A comparator glued to the end of the preceding version (fast-uri
    // GHSA-p9qr-jj7q-p3v3): "3.0.0<= 3.1.0" means ">=3.0.0 <=3.1.0".
    ['<=2.4.0; 3.0.0<= 3.1.0', '<=2.4.0||>=3.0.0 <=3.1.0'],
  ])('normalizes %s', (raw, expected) => {
    expect(normalizeAdvisoryRange(raw)).toBe(expected);
  });

  it('reads comma as OR when the parts cannot be a single AND group', () => {
    // brace-expansion GHSA-qhr7-859c-m2p7 (HIGH), recorded verbatim. Treating these
    // commas as AND yields `<1.1.20 >=2.0.0 ...`, which is unsatisfiable and matches
    // NOTHING — silently dropping a HIGH advisory. That is the bug this case pins.
    const raw = '< 1.1.20, >= 2.0.0 < 2.1.6, >= 3.0.0 < 3.0.8, >= 4.0.0 < 5.0.11';
    const range = normalizeAdvisoryRange(raw);

    for (const vulnerable of ['1.1.19', '2.0.0', '2.1.5', '3.0.7', '4.0.0', '5.0.10']) {
      expect(semver.satisfies(vulnerable, range)).toBe(true);
    }
    for (const safe of ['1.1.20', '2.1.6', '3.0.8', '5.0.11', '5.0.12']) {
      expect(semver.satisfies(safe, range)).toBe(false);
    }
  });

  it('agrees with the global DB form of the same advisory', () => {
    // GHSA-mh99-v99m-4gvg as the global DB normalizes it, versus as juliangruber/
    // brace-expansion authored it. Both must condemn exactly the same versions —
    // this is the cross-check that the messy-form parser is not guessing.
    const global = normalizeAdvisoryRange(
      '>= 4.0.0, < 5.0.8 | >= 3.0.0, < 3.0.3 | >= 2.0.0, < 2.1.3 | < 1.1.17'
        .split(' | ')
        .join(';'),
    );
    const upstream = normalizeAdvisoryRange(
      '<1.1.17 >= 2.0.0 < 2.1.3 >= 3.0.0 < 3.0.3 4.0.0 - 5.0.7',
    );

    const sample = [
      '1.1.16', '1.1.17', '2.0.5', '2.1.3', '3.0.2', '3.0.3',
      '4.0.0', '5.0.7', '5.0.8', '5.0.9',
    ];
    for (const version of sample) {
      expect(semver.satisfies(version, upstream)).toBe(semver.satisfies(version, global));
    }
  });

  it('throws on a range it cannot parse rather than matching nothing', () => {
    expect(() => normalizeAdvisoryRange('all versions before the rewrite')).toThrow(
      /cannot parse/i,
    );
  });

  it('throws on an empty range', () => {
    expect(() => normalizeAdvisoryRange('   ')).toThrow(/cannot parse/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Trap 1 + 2 — the newest patch is not the safe floor, and a floor on one
//    major does not constrain another.
// ---------------------------------------------------------------------------

describe('safe-floor computation', () => {
  const source = fakeSource({
    versions: { undici: UNDICI_VERSIONS },
    global: { undici: UNDICI_ADVISORIES },
  });

  it('fails a floor set at the newest patched version of the wrong major', async () => {
    // 7.29.1 is itself clean, but 8.0.0-8.10.1 sit ABOVE it and are not.
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  undici: '>=7.29.1'`),
      policy: NO_POLICY,
      source,
    });

    expect(report.errors).toEqual([]);
    expect(report.stale).toHaveLength(1);
    const [finding] = report.stale;
    expect(finding!.subject).toBe('undici');
    expect(finding!.currentFloor).toBe('>=7.29.1');
    expect(finding!.safeFloor).toBe('>=8.10.2');
    // 7.29.1 is clean and must not be reported as vulnerable.
    expect(finding!.vulnerableVersions).not.toContain('7.29.1');
    expect(finding!.vulnerableVersions).toContain('8.10.1');
    expect(finding!.advisories.map((a) => a.ghsaId)).toContain('GHSA-3wwx-pv8p-q78v');
  });

  it('passes the floor that actually closes every admitted advisory', async () => {
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  undici: '>=8.10.2'`),
      policy: NO_POLICY,
      source,
    });

    expect(report.errors).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  it('excludes prereleases from the admitted set', async () => {
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  undici: '>=8.10.2'`),
      policy: NO_POLICY,
      source,
    });

    expect(report.checked[0]!.admittedVersions).not.toContain('8.12.0-rc.1');
    expect(report.checked[0]!.admittedVersions).toEqual(['8.10.2', '8.11.0']);
  });

  it('names 8.0.16 as the safe floor for vite >=8.0.5', async () => {
    // Recorded: GHSA-fx2h-pf6j-xcff (HIGH) and GHSA-v6wh-96g9-6wx3 (MED) both
    // close at 8.0.16 via the range ">= 8.0.0, <= 8.0.15".
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  vite: '>=8.0.5'`),
      policy: NO_POLICY,
      source: fakeSource({
        versions: {
          vite: ['8.0.4', '8.0.5', '8.0.14', '8.0.15', '8.0.16', '8.1.0'],
        },
        global: {
          vite: [
            adv('GHSA-fx2h-pf6j-xcff', 'high', ['>= 8.0.0, <= 8.0.15']),
            adv('GHSA-v6wh-96g9-6wx3', 'medium', ['>= 8.0.0, <= 8.0.15']),
          ],
        },
      }),
    });

    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]!.safeFloor).toBe('>=8.0.16');
    expect(report.stale[0]!.advisories.map((a) => a.severity)).toContain('high');
    expect(report.exitCode).toBe(1);
  });

  it('keeps the computed safe floor inside a compound range upper bound', async () => {
    // Targeted to the 7.x line: the 8.x advisory must not drag the floor to 8.x.
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  'onnxruntime-web>protobufjs': '>=7.6.3 <8'`),
      policy: NO_POLICY,
      source: fakeSource({
        versions: {
          protobufjs: ['7.6.3', '7.6.4', '7.6.5', '7.6.6', '8.0.0', '8.6.5', '8.8.0'],
        },
        global: {
          protobufjs: [
            adv('GHSA-j3f2-48v5-ccww', 'medium', [
              '>= 7.5.0, <= 7.6.4',
              '>= 8.0.0, <= 8.6.5',
            ]),
          ],
        },
      }),
    });

    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]!.safeFloor).toBe('>=7.6.5 <8');
    expect(report.stale[0]!.vulnerableVersions).toEqual(['7.6.3', '7.6.4']);
  });

  it('reports that no safe floor exists when every admitted version is vulnerable', async () => {
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  uuid: '^11.1.1'`),
      policy: NO_POLICY,
      source: fakeSource({
        versions: { uuid: ['11.1.1', '11.2.0', '14.0.0'] },
        global: { uuid: [adv('GHSA-qmq6-f8pr-cx5x', 'low', ['< 14.0.0'])] },
      }),
    });

    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]!.safeFloor).toBeNull();
    expect(formatReport(report)).toMatch(/no safe floor/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Trap 3 — upstream repo advisories
// ---------------------------------------------------------------------------

describe('upstream repo advisories', () => {
  it('fails a floor that only the upstream repo advisories condemn', async () => {
    // The real case: GHSA-jvvf-x445-j334 / GHSA-hrr3-gc8f-f4qj (fast-uri <4.1.5)
    // are published on fastify/fast-uri but were absent from the global DB, so
    // >=4.1.4 looked correct. Global DB here carries only the already-closed one.
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  fast-uri: '>=4.1.4'`),
      policy: NO_POLICY,
      source: fakeSource({
        versions: { 'fast-uri': ['4.1.3', '4.1.4', '4.1.5', '4.2.0', '4.2.1'] },
        repos: { 'fast-uri': 'fastify/fast-uri' },
        global: {
          'fast-uri': [adv('GHSA-58mr-gqgx-xq4g', 'high', ['>= 4.0.0, < 4.1.4'])],
        },
        repoAdvisories: {
          'fastify/fast-uri': {
            'fast-uri': [
              adv('GHSA-jvvf-x445-j334', 'medium', ['>= 4.1.3, < 4.1.5'], 'upstream-repo'),
              adv('GHSA-hrr3-gc8f-f4qj', 'medium', ['>= 4.0.0, < 4.1.5'], 'upstream-repo'),
            ],
          },
        },
      }),
    });

    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]!.safeFloor).toBe('>=4.1.5');
    expect(report.stale[0]!.advisories.map((a) => a.ghsaId).sort()).toEqual([
      'GHSA-hrr3-gc8f-f4qj',
      'GHSA-jvvf-x445-j334',
    ]);
    expect(report.stale[0]!.advisories.every((a) => a.source === 'upstream-repo')).toBe(
      true,
    );
  });

  it('ignores a sibling package advisory from the same monorepo', async () => {
    // Real false positive this caught: open-telemetry/opentelemetry-js publishes
    // GHSA-45rx-2jwx-cxfr, which affects @opentelemetry/propagator-jaeger — NOT
    // @opentelemetry/core. A repo-wide fetch that forgets to filter by package name
    // reports a HIGH against the wrong pin and sends someone chasing a phantom.
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  '@opentelemetry/core': '>=2.8.0'`),
      policy: NO_POLICY,
      source: fakeSource({
        versions: { '@opentelemetry/core': ['2.8.0', '2.9.0'] },
        repos: { '@opentelemetry/core': 'open-telemetry/opentelemetry-js' },
        global: {
          '@opentelemetry/core': [
            adv('GHSA-8988-4f7v-96qf', 'medium', ['< 2.8.0']),
          ],
        },
        repoAdvisories: {
          'open-telemetry/opentelemetry-js': {
            '@opentelemetry/propagator-jaeger': [
              adv('GHSA-45rx-2jwx-cxfr', 'high', ['< 2.9.0'], 'upstream-repo'),
            ],
          },
        },
      }),
    });

    expect(report.errors).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3b. Raw API payload -> AdvisoryRecord
// ---------------------------------------------------------------------------

describe('toAdvisoryRecords', () => {
  it('keeps only vulnerabilities naming the requested package', () => {
    // Verbatim shape of open-telemetry/opentelemetry-js GHSA-45rx-2jwx-cxfr. The repo
    // advisory endpoint is keyed by REPO, so a monorepo returns advisories for every
    // package it ships; attributing this one to @opentelemetry/core would be a phantom
    // HIGH against a pin it has nothing to do with.
    const raw: RawAdvisory[] = [
      {
        ghsa_id: 'GHSA-45rx-2jwx-cxfr',
        severity: 'high',
        state: 'published',
        withdrawn_at: null,
        vulnerabilities: [
          {
            package: { ecosystem: 'npm', name: '@opentelemetry/propagator-jaeger' },
            vulnerable_version_range: '< 2.9.0',
          },
        ],
      },
    ];

    expect(toAdvisoryRecords(raw, '@opentelemetry/core', 'upstream-repo')).toEqual([]);
    expect(
      toAdvisoryRecords(raw, '@opentelemetry/propagator-jaeger', 'upstream-repo'),
    ).toEqual([
      {
        ghsaId: 'GHSA-45rx-2jwx-cxfr',
        severity: 'high',
        ranges: ['< 2.9.0'],
        source: 'upstream-repo',
      },
    ]);
  });

  it('drops withdrawn and unpublished advisories', () => {
    const vulnerabilities = [
      { package: { ecosystem: 'npm', name: 'left-pad' }, vulnerable_version_range: '< 9.9.9' },
    ];
    const raw: RawAdvisory[] = [
      { ghsa_id: 'GHSA-with-draw-n001', severity: 'high', withdrawn_at: '2026-01-01T00:00:00Z', vulnerabilities },
      { ghsa_id: 'GHSA-draf-t000-0002', severity: 'high', state: 'draft', vulnerabilities },
      { ghsa_id: 'GHSA-good-0000-0003', severity: 'high', state: 'published', vulnerabilities },
    ];

    expect(toAdvisoryRecords(raw, 'left-pad', 'global').map((r) => r.ghsaId)).toEqual([
      'GHSA-good-0000-0003',
    ]);
  });

  it('ignores non-npm ecosystems', () => {
    const raw: RawAdvisory[] = [
      {
        ghsa_id: 'GHSA-pypi-0000-0001',
        severity: 'high',
        state: 'published',
        vulnerabilities: [
          { package: { ecosystem: 'pip', name: 'undici' }, vulnerable_version_range: '< 9.9.9' },
        ],
      },
    ];

    expect(toAdvisoryRecords(raw, 'undici', 'global')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Allowlist
// ---------------------------------------------------------------------------

describe('allowlist', () => {
  const uuidSource = fakeSource({
    versions: { uuid: ['11.1.1', '11.2.0', '14.0.0'] },
    global: { uuid: [adv('GHSA-qmq6-f8pr-cx5x', 'low', ['< 14.0.0'])] },
  });
  const uuidYaml = yamlWith(`  uuid: '^11.1.1'`);

  it('accepts a declared exception', async () => {
    const report = await auditOverrideFloors({
      workspaceYaml: uuidYaml,
      policy: {
        allowlist: [
          {
            package: 'uuid',
            ghsa: 'GHSA-qmq6-f8pr-cx5x',
            reason: 'Only fix is 14.0.0; uuid@11 is the last CJS major the Nylas SDK can use.',
          },
        ],
        noAdvisoryExpected: [],
      },
      source: uuidSource,
    });

    expect(report.errors).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  it('still fails on a DIFFERENT advisory for an allowlisted package', async () => {
    const report = await auditOverrideFloors({
      workspaceYaml: uuidYaml,
      policy: {
        allowlist: [
          {
            package: 'uuid',
            ghsa: 'GHSA-qmq6-f8pr-cx5x',
            reason: 'Only fix is 14.0.0; uuid@11 is the last CJS major the Nylas SDK can use.',
          },
        ],
        noAdvisoryExpected: [],
      },
      source: fakeSource({
        versions: { uuid: ['11.1.1', '11.2.0', '11.3.0', '14.0.0'] },
        global: {
          uuid: [
            adv('GHSA-qmq6-f8pr-cx5x', 'low', ['< 14.0.0']),
            adv('GHSA-newone-0000-0000', 'high', ['>= 11.0.0, < 11.3.0']),
          ],
        },
      }),
    });

    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]!.advisories.map((a) => a.ghsaId)).toEqual([
      'GHSA-newone-0000-0000',
    ]);
    // The suggested floor keeps the caret: rewriting it to `>=11.3.0` would silently
    // drop the major cap, which exists because uuid@12+ is ESM-only.
    expect(report.stale[0]!.safeFloor).toBe('^11.3.0');
  });

  it('rejects an entry with no reason', async () => {
    const report = await auditOverrideFloors({
      workspaceYaml: uuidYaml,
      policy: {
        allowlist: [{ package: 'uuid', ghsa: 'GHSA-qmq6-f8pr-cx5x', reason: '  ' }],
        noAdvisoryExpected: [],
      },
      source: uuidSource,
    });

    expect(report.exitCode).toBe(1);
    expect(report.errors.join('\n')).toMatch(/reason/i);
  });

  it('rejects an entry whose ghsa id is malformed', async () => {
    const report = await auditOverrideFloors({
      workspaceYaml: uuidYaml,
      policy: {
        allowlist: [{ package: 'uuid', ghsa: 'CVE-2026-1234', reason: 'wrong id kind' }],
        noAdvisoryExpected: [],
      },
      source: uuidSource,
    });

    expect(report.exitCode).toBe(1);
    expect(report.errors.join('\n')).toMatch(/GHSA-/);
  });

  it('reports an allowlist entry that no longer suppresses anything', async () => {
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  uuid: '>=14.0.0'`),
      policy: {
        allowlist: [
          {
            package: 'uuid',
            ghsa: 'GHSA-qmq6-f8pr-cx5x',
            reason: 'kept after the floor moved past it',
          },
        ],
        noAdvisoryExpected: [],
      },
      source: uuidSource,
    });

    // Stale suppression is housekeeping, not a security hole: report it, stay green.
    expect(report.stale).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(report.unusedAllowlist.map((e) => e.ghsa)).toEqual(['GHSA-qmq6-f8pr-cx5x']);
    expect(formatReport(report)).toMatch(/GHSA-qmq6-f8pr-cx5x/);
  });
});

// ---------------------------------------------------------------------------
// 5. Loud failure, never pass-by-default
// ---------------------------------------------------------------------------

describe('failure modes', () => {
  it('fails loudly when the advisory query errors', async () => {
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  undici: '>=8.10.2'`),
      policy: NO_POLICY,
      source: fakeSource({
        versions: { undici: UNDICI_VERSIONS },
        fail: { undici: 'HTTP 503 from api.github.com' },
      }),
    });

    expect(report.exitCode).toBe(1);
    expect(report.errors.join('\n')).toMatch(/503/);
    // An erroring override must NOT be silently counted as clean.
    expect(report.checked).toEqual([]);
  });

  it('fails when a package returns no advisories at all', async () => {
    // Every override exists because of an advisory, so an empty result means the
    // query broke, not that the package is clean.
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  undici: '>=8.10.2'`),
      policy: NO_POLICY,
      source: fakeSource({ versions: { undici: UNDICI_VERSIONS }, global: {} }),
    });

    expect(report.exitCode).toBe(1);
    expect(report.errors.join('\n')).toMatch(/no advisories/i);
  });

  it('tolerates an empty advisory list only when the override declares it', async () => {
    // `gaxios>rimraf` exists to drop a brace-expansion@2.x path, not to clear a
    // rimraf advisory — rimraf genuinely has zero npm advisories.
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  'gaxios>rimraf': '>=6.1.2'`),
      policy: {
        allowlist: [],
        noAdvisoryExpected: [
          {
            override: 'gaxios>rimraf',
            reason: 'Pinned to drop the only brace-expansion@2.x path, not for a rimraf CVE.',
          },
        ],
      },
      source: fakeSource({ versions: { rimraf: ['6.1.2', '6.1.3'] }, global: {} }),
    });

    expect(report.errors).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  it('fails on an override whose specifier cannot be parsed', async () => {
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  undici: 'latest'`),
      policy: NO_POLICY,
      source: fakeSource({ versions: { undici: UNDICI_VERSIONS } }),
    });

    expect(report.exitCode).toBe(1);
    expect(report.errors.join('\n')).toMatch(/undici/);
    expect(report.checked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. Report formatting
// ---------------------------------------------------------------------------

describe('formatReport', () => {
  it('states the floor, the vulnerable versions, the advisories and the safe floor', async () => {
    const report = await auditOverrideFloors({
      workspaceYaml: yamlWith(`  undici: '>=7.29.1'`),
      policy: NO_POLICY,
      source: fakeSource({
        versions: { undici: UNDICI_VERSIONS },
        global: { undici: UNDICI_ADVISORIES },
      }),
    });
    const text = formatReport(report);

    expect(text).toContain('undici');
    expect(text).toContain('>=7.29.1');
    expect(text).toContain('8.10.1');
    expect(text).toContain('GHSA-3wwx-pv8p-q78v');
    expect(text).toContain('high');
    expect(text).toContain('>=8.10.2');
  });
});
