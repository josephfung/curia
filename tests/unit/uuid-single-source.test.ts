// uuid-single-source.test.ts — static analysis guard keeping the UUID matcher in one place.
//
// #1879 consolidated 30 independently-declared copies of the 8-4-4-4-12 regex into
// src/util/uuid.ts. Nothing was broken at the time — gen_random_uuid() output passes
// every variant — but two of the 30 had already drifted stricter than the rest, and
// both failed in ways nobody would have traced back to a regex:
//
//   - src/channels/http/routes/kg.ts answered a legitimate v7 or nil id with a 400
//     and no explanation.
//   - src/scheduler/conversation-id.ts returned undefined, which every caller reads
//     as "not a scheduled run" rather than "malformed id" — silently stopping
//     scheduler-report from deriving job_id and bullpen from detecting
//     job-UUID-as-thread_id, with nothing logged.
//
// A prose comment saying "keep this list exhaustive" cannot enforce itself. This scan
// can. It is also specifically the thing that would have caught #1879's own blind
// spot: the issue counted 29 copies because it grepped for `[0-9a-f]` and never saw
// the two spelled `[0-9a-fA-F]`. Matching on shape rather than on one hex spelling
// makes that class of miss impossible.
//
// If this test fails, you have added a UUID regex. Import isUuid() (or UUID_PATTERN,
// if you are composing it into a larger regex) instead. If your case genuinely needs
// its own regex, add it to ALLOWED below *and* to the exception list in the
// src/util/uuid.ts header, with a reason.
//
// Limits of this scan (deliberate, not oversights):
// - **Shape, not semantics.** It finds 8-4-4-4-12 hex skeletons. It cannot tell a
//   validation regex from a redaction scan, which is why the scrubber needs an
//   explicit entry rather than being auto-detected.
// - **Production code only.** Tests legitimately assert on UUID shape — e.g.
//   tests/unit/memory/types.test.ts and tests/unit/agents/late-delegation.test.ts check
//   randomUUID() output. Those are assertions about generated values, not identifier
//   validation, so *.test.ts is skipped.
// - **Not SQL.** Migrations use Postgres `~*` matches, which this does not walk.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const SCANNED_DIRS = ['src', 'skills'];

/**
 * Files permitted to declare their own UUID regex. Every entry must also appear in
 * the exception list in the src/util/uuid.ts module header — keep the two in sync.
 */
const ALLOWED = new Set([
  // The shared helper itself: this is the one source of truth.
  'src/util/uuid.ts',
  // A \b-bounded /g scan that *finds* UUIDs inside free log text to redact them.
  // Unanchored and stateful — a different job from an anchored identity check, and
  // consolidating it would break PII scrubbing. See the comment in that file.
  'src/pii/scrubber.ts',
]);

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...collectTsFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    // Tests assert on generated UUIDs; that is not identifier validation.
    if (entry.name.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/**
 * Find UUID-shaped regex skeletons, independent of how the hex class is spelled.
 *
 * Every character class is first collapsed to a single `X`, so all of these reduce to
 * the same normalized form and are caught alike:
 *
 *   [0-9a-f]{8}-...          the loose form, 20 of the 30 copies
 *   [0-9a-fA-F]{8}-...       the spelling #1879's grep missed
 *   [0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-...
 *                            the drifted-strict form (version + variant nibbles)
 *
 * After collapsing, a UUID skeleton is `X{8}-` … `{12}` with only classes, digits,
 * quantifiers and hyphens in between.
 */
function findUuidShapes(source: string): number[] {
  // Collapse character classes to X, preserving length so offsets stay usable as a
  // rough line locator (a class is never shorter than one char).
  const normalized = source.replace(/\[[^\]\n]*\]/g, (m) => 'X'.padEnd(m.length, ' '));
  const skeleton = /X\s*\{8\}-[X0-9{}\-\s]{6,80}\{12\}/g;
  const lines: number[] = [];
  for (const match of normalized.matchAll(skeleton)) {
    const upto = source.slice(0, match.index);
    lines.push(upto.split('\n').length);
  }
  return lines;
}

describe('UUID matcher lives in exactly one place (#1879)', () => {
  const offenders: string[] = [];

  for (const dir of SCANNED_DIRS) {
    for (const file of collectTsFiles(path.join(REPO_ROOT, dir))) {
      const rel = path.relative(REPO_ROOT, file);
      if (ALLOWED.has(rel)) continue;
      for (const line of findUuidShapes(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${rel}:${line}`);
      }
    }
  }

  it('finds no UUID regex outside src/util/uuid.ts and the documented exception', () => {
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Found ${offenders.length} UUID regex(es) outside the shared helper:\n` +
            offenders.map((o) => `  - ${o}`).join('\n') +
            `\n\nImport { isUuid } from 'src/util/uuid.js' instead — or { UUID_PATTERN } if you ` +
            `are composing it into a larger regex. If this file genuinely needs its own, add it ` +
            `to ALLOWED in this test AND to the exception list in the src/util/uuid.ts header, ` +
            `with a reason. See #1879 for why 30 copies was a problem.`,
    ).toEqual([]);
  });

  // Guards the guard: if the detector stops matching real-world spellings, the scan
  // above would pass vacuously and the whole test would be theatre.
  it('detects every hex-class spelling and the drifted-strict form', () => {
    const loose = 'const A = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;';
    const mixedCase =
      'const B = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;';
    const drifted =
      'const C = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;';
    const patternString =
      "const D = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';";
    const wrapped =
      'const E =\n  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;';
    const scrubberStyle =
      'const F = /\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b/gi;';

    for (const [label, sample] of Object.entries({
      loose,
      mixedCase,
      drifted,
      patternString,
      wrapped,
      scrubberStyle,
    })) {
      expect(findUuidShapes(sample), `should detect the ${label} form`).toHaveLength(1);
    }
  });

  it('does not fire on unrelated hex patterns', () => {
    // 8-hex short refs (src/autonomy/reaction-approval-mapper.ts) are not UUIDs.
    expect(findUuidShapes('const R = /\\bReference:\\s*([0-9a-f]{8})\\b/i;')).toEqual([]);
    expect(findUuidShapes("expect(ref).toMatch(/^[0-9a-f]{8}$/);")).toEqual([]);
    // A 12-hex run on its own is not a UUID either.
    expect(findUuidShapes('const M = /^[0-9a-f]{12}$/;')).toEqual([]);
  });

  it('keeps ALLOWED honest — every entry exists and still declares a UUID regex', () => {
    for (const rel of ALLOWED) {
      const full = path.join(REPO_ROOT, rel);
      expect(fs.existsSync(full), `${rel} is in ALLOWED but does not exist`).toBe(true);
      expect(
        findUuidShapes(fs.readFileSync(full, 'utf8')).length,
        `${rel} is in ALLOWED but no longer declares a UUID regex — drop the entry`,
      ).toBeGreaterThan(0);
    }
  });
});
