#!/usr/bin/env tsx
// scripts/audit-override-floors.ts
//
// Assert that every `overrides:` floor in pnpm-workspace.yaml is SOUND: that every
// published release the floor admits is free of known advisories. #1934.
//
// Run locally:  GITHUB_TOKEN=$(gh auth token) pnpm audit:override-floors
// Run in CI:    .github/workflows/override-floor-audit.yml (daily + on workspace edits)
//
// Exit codes: 0 = no floor is failing, 1 = a stale floor, a parse error, or an API failure.
// A stale floor whose fix is younger than the workspace's own `minimumReleaseAge` is a
// third state: reported loudly, exit 0, self-clearing. See quarantineExpiry.
//
// WHY THIS EXISTS
// ---------------
// A floor only protects you if EVERYTHING at or above it is clean. In practice a pin
// gets set to the version that patched whatever advisory prompted it; later advisories
// land on the same line and the floor silently stops protecting anything. It stays
// silent because natural resolution usually lands above the floor anyway, so Dependabot
// sees a clean resolved tree and reports nothing. That is how `ajv` came to hold
// `fast-uri@4.1.3` under a `>=4.1.2` floor (#1933, which found seven more of the same).
//
// Three traps this check is built around, all of which were live in the file before #1933:
//
//   1. "Patched version" is not "safe floor". undici 7.29.1 is clean, but 8.0.0-8.10.1
//      sit ABOVE it carrying five HIGH advisories. The safe floor is the lowest version
//      above which EVERYTHING published is clean — so we enumerate the admitted set and
//      test every member, rather than trusting any advisory's `first_patched_version`.
//   2. A floor on one major does not constrain another. `undici: '>=7.28.0'` admitted the
//      entire 8.x line. Falls out of (1) for free: 8.x versions are in the admitted set.
//   3. The global advisory DB lags a project's own repo. GHSA-jvvf-x445-j334 and
//      GHSA-hrr3-gc8f-f4qj (fast-uri <4.1.5) were published on fastify/fast-uri but not
//      in GitHub's global DB, so no Dependabot alert existed and `>=4.1.4` looked right.
//      We therefore query BOTH sources. Where both carry the same GHSA the global record
//      wins, because only it has normalized ranges — see collectAdvisories.
//
// This is not a replacement for Dependabot. Dependabot answers "is the tree I resolved
// vulnerable"; this answers "would my floors still protect me if resolution moved".

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import semver from 'semver';

// ---------------------------------------------------------------------------
// Policy: declared exceptions
// ---------------------------------------------------------------------------

export interface AllowlistEntry {
  /** The advisory SUBJECT package (the child of a targeted `parent>child` key). */
  package: string;
  /** The single GHSA id being accepted. A blanket skip is deliberately impossible. */
  ghsa: string;
  /** Why it is accepted. Required — an exception with no rationale is a silent hole. */
  reason: string;
}

export interface NoAdvisoryExpectedEntry {
  /** The override KEY exactly as written in pnpm-workspace.yaml. */
  override: string;
  reason: string;
}

export interface AuditPolicy {
  allowlist: AllowlistEntry[];
  /**
   * Overrides that exist for a NON-security reason. Every other override is here
   * because of an advisory, so an empty advisory response for one of those means the
   * query broke, not that the package is clean — and we fail rather than pass. These
   * entries opt out of that specific assertion ONLY; their admitted versions are still
   * audited, so a future advisory on the package is still caught.
   */
  noAdvisoryExpected: NoAdvisoryExpectedEntry[];
}

export const DEFAULT_POLICY: AuditPolicy = {
  // Empty on purpose. #1934 expected one entry here — uuid / GHSA-qmq6-f8pr-cx5x, the
  // LOW buffer-bounds issue in v3/v5/v6 that the deliberate `uuid: '^11.1.1'` cap cannot
  // escape (the only fix is 14.0.0, and uuid@11 is the last major shipping the CommonJS
  // build the Nylas SDK requires). That advisory was WITHDRAWN upstream on 2026-05-05, so
  // this auditor drops it along with every other retraction and the exception buys
  // nothing. Leaving it declared would have shown up permanently as an unused entry.
  //
  // If GitHub ever un-withdraws it, this check will fail on `uuid` — which is correct,
  // and the paragraph above is the reasoning to paste back in.
  allowlist: [],
  noAdvisoryExpected: [
    {
      override: 'gaxios>rimraf',
      reason:
        'Pinned to drop the only brace-expansion@2.x path (promptfoo->gaxios->rimraf@5-> ' +
        'glob@10->minimatch@9), not to clear a rimraf advisory. rimraf has no npm advisories.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Carries the HTTP status so callers branch on the status, not on message text. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Coverage was reduced but the audit can continue. Distinct from a plain Error, which
 * fails the override: this lands in `report.degraded` instead, so "I could not check this
 * part" is never rendered as either a failure or a clean result.
 */
export class DegradedCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DegradedCoverageError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface AdvisoryRecord {
  ghsaId: string;
  severity: Severity;
  /**
   * Vulnerable version ranges for ONE package, exactly as the API returned them.
   * They are NOT semver ranges yet — see normalizeAdvisoryRange for the two dialects
   * GitHub serves and why converting them is the delicate part of this script.
   */
  ranges: string[];
  source: 'global' | 'upstream-repo';
}

export interface PackageDataSource {
  /** Every published version. Prereleases included; the auditor filters them out. */
  listVersions(pkg: string): Promise<string[]>;
  /** "owner/repo" from the package's `repository` field, or null if absent/non-GitHub. */
  upstreamRepo(pkg: string): Promise<string | null>;
  globalAdvisories(pkg: string): Promise<AdvisoryRecord[]>;
  /**
   * Advisories published on `slug` that affect `pkg`.
   *
   * `pkg` is not optional on purpose. A monorepo's advisory list covers every package
   * it ships — open-telemetry/opentelemetry-js publishes advisories for
   * `@opentelemetry/propagator-jaeger` that have nothing to do with
   * `@opentelemetry/core` — so an unfiltered fetch invents HIGH findings against the
   * wrong pin. Taking the package name here makes that filter impossible to forget.
   */
  repoAdvisories(slug: string, pkg: string): Promise<AdvisoryRecord[]>;
  /** ISO publish time of one version, or null if the registry does not report it. */
  publishedAt(pkg: string, version: string): Promise<string | null>;
}

export interface OverrideEntry {
  /** The key as written, e.g. `onnxruntime-web>protobufjs`. */
  key: string;
  specifier: string;
  /** The package the advisories are about — the child of a targeted key. */
  subject: string;
}

export interface ImplicatedAdvisory {
  ghsaId: string;
  severity: Severity;
  source: AdvisoryRecord['source'];
}

export interface CheckedOverride {
  key: string;
  subject: string;
  currentFloor: string;
  admittedVersions: string[];
}

export interface StaleFloor extends CheckedOverride {
  vulnerableVersions: string[];
  advisories: ImplicatedAdvisory[];
  /**
   * The lowest admitted version above every vulnerable one, rendered as a specifier
   * that preserves the original's shape (upper bound, caret). `null` means no admitted
   * version is clean, so the override cannot be fixed by raising the floor alone.
   */
  safeFloor: string | null;
}

/**
 * A stale floor whose remedy is younger than the workspace's own `minimumReleaseAge`
 * quarantine. Reported separately and does NOT fail the run — see the note on
 * quarantineExpiry for why this is a real third state rather than a suppression.
 */
export interface QuarantinedFloor extends StaleFloor {
  safeFloor: string;
  /**
   * The clean admitted version that ages out of the quarantine FIRST — the one whose
   * maturity makes `safeFloor` resolvable, and the one `installableAt` belongs to.
   */
  safeVersion: string;
  /**
   * ISO timestamp at which `safeVersion` ages past the quarantine, i.e. when this finding
   * becomes an ordinary failure. Paired with `safeVersion` deliberately: reporting one
   * version's name beside another's window is how the report came to contradict the
   * verdict.
   */
  installableAt: string;
}

export interface AuditReport {
  checked: CheckedOverride[];
  stale: StaleFloor[];
  /** Stale, but the fix cannot be installed yet. Loud, self-clearing, non-failing. */
  quarantined: QuarantinedFloor[];
  /** Hard failures: unparseable entries, API errors, undeclared empty advisory sets. */
  errors: string[];
  /**
   * Cases where the audit ran but its COVERAGE was reduced — a package with no resolvable
   * GitHub repo, a repo whose advisory list 404s, a quarantine status that could not be
   * determined. Review named the unifying flaw in the first draft: the script had words
   * for "broken" and for "fine" and none for "I checked less than I should have", so every
   * such case rendered as clean. These do not fail the run, but they are printed, and they
   * suppress the "all floors are sound" claim, which would otherwise be a lie.
   */
  degraded: string[];
  /** Allowlist entries that no longer suppress anything. Housekeeping, not a failure. */
  unusedAllowlist: AllowlistEntry[];
  /** Same rot detection for the escape hatch from the empty-advisory-list assertion. */
  unusedNoAdvisoryExpected: NoAdvisoryExpectedEntry[];
  exitCode: 0 | 1;
}

export interface AuditOptions {
  workspaceYaml: string;
  policy: AuditPolicy;
  source: PackageDataSource;
  /** Injected so the quarantine window is testable without freezing the clock. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Strip a trailing `@<range>` from an override key segment without eating the leading
 * `@` of a scoped name: `@scope/child@2` -> `@scope/child`, `semver@7` -> `semver`.
 */
function stripVersionSuffix(segment: string): string {
  const at = segment.lastIndexOf('@');
  return at > 0 ? segment.slice(0, at) : segment;
}

/**
 * The advisory subject of an override key. For a targeted `parent>child` pin the
 * subject is the CHILD — pinning `onnxruntime-web>protobufjs` is about protobufjs.
 */
export function overrideSubject(key: string): string {
  const segments = key.split('>');
  const last = segments[segments.length - 1] ?? key;
  return stripVersionSuffix(last.trim());
}

interface WorkspaceShape {
  overrides?: unknown;
  minimumReleaseAge?: unknown;
}

/**
 * The workspace's supply-chain quarantine, in minutes, or null if it sets none.
 *
 * Read from the same file as the overrides rather than hardcoded, so the audit can never
 * disagree with the policy pnpm actually enforces.
 */
export const MAX_QUARANTINE_MINUTES = 7 * 24 * 60;

export function parseMinimumReleaseAge(workspaceYaml: string): number | null {
  const doc = yaml.load(workspaceYaml) as WorkspaceShape | null | undefined;
  const raw = doc?.minimumReleaseAge;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  // The file under audit controls the audit's own leniency, and the PR that would trip
  // this check is the PR that can edit this value. A stray digit (1440 -> 14400000, i.e.
  // 27 years) would otherwise turn every stale floor into a green "awaiting a quarantined
  // fix" indefinitely. Anything beyond the Dependabot cooldown is a typo, not a policy.
  if (raw > MAX_QUARANTINE_MINUTES) {
    throw new Error(
      `minimumReleaseAge is ${raw} minutes (${Math.round(raw / 1440)} days), above the ` +
        `${MAX_QUARANTINE_MINUTES}-minute ceiling this audit will honour. A value this ` +
        'large would excuse every stale floor indefinitely — is it a typo?',
    );
  }
  return raw;
}

export function parseOverrides(workspaceYaml: string): OverrideEntry[] {
  // js-yaml's `load` uses DEFAULT_SCHEMA, which constructs only plain JSON types —
  // the arbitrary-type-construction risk belongs to PyYAML's load and to js-yaml's
  // explicit FULL/unsafe schemas, neither of which is in play here.
  const doc = yaml.load(workspaceYaml) as WorkspaceShape | null | undefined;
  const overrides = doc?.overrides;
  if (overrides === undefined || overrides === null) {
    throw new Error('pnpm-workspace.yaml has no `overrides:` block to audit');
  }
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('`overrides:` is not a mapping');
  }

  return Object.entries(overrides as Record<string, unknown>).map(([key, value]) => {
    if (typeof value !== 'string') {
      // A non-string override (pnpm allows object forms) is not something this check
      // understands. Say so rather than skipping it — a skipped entry is unaudited.
      throw new Error(
        `override \`${key}\`: expected a version specifier string, got ${typeof value}`,
      );
    }
    return { key, specifier: value, subject: overrideSubject(key) };
  });
}

/**
 * Normalize a floor specifier to a semver range, throwing if it cannot be parsed.
 *
 * Deliberately NOT a hand-written list of accepted shapes (`>=X`, `>=X <Y`, `^X`).
 * Such a list is the same kind of narrow allowlist this whole script exists to
 * replace: it goes stale the moment someone writes a legitimate form nobody listed,
 * and the failure mode is a skipped — therefore unaudited — override. Anything semver
 * itself understands is admitted, and the audit below is correct for all of them.
 */
export function parseFloorRange(specifier: string): string {
  // A multi-branch specifier has no single lower bound to raise, and renderSafeFloor can
  // only rewrite one: for `^1.0.0 || ^2.0.0` it produced `^2.2.0 || ^2.0.0`, which still
  // admits the vulnerable 2.0.0 it was meant to escape. The workflow tells maintainers to
  // apply the suggested floor, so wrong advice is worse than no support. Nothing here
  // uses `||`; if that changes, teach renderSafeFloor first.
  if (specifier.includes('||')) {
    throw new Error(
      `version specifier \`${specifier}\` uses \`||\`, which this audit cannot suggest a ` +
        'safe floor for. Split it into separate overrides, or extend renderSafeFloor.',
    );
  }
  const range = semver.validRange(specifier);
  if (range === null) {
    throw new Error(`cannot parse version specifier \`${specifier}\` as a semver range`);
  }
  return range;
}

/** An npm package name we are willing to interpolate into a registry path. */
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
/** An owner/repo slug we are willing to interpolate into an api.github.com path. */
const SAFE_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Resolve a package's `repository` field to an `owner/repo` GitHub slug, or null.
 *
 * Load-bearing for trap 3: a null slug means the upstream-repo advisory leg never runs and
 * the audit silently degrades to global-DB-only, which is the blind spot #1933 was about.
 * The first version matched `/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?$/`, wrong twice:
 *
 *   - Anchoring the repo at `$` rejected every shape that is not exactly two TRAILING path
 *     segments. `github:squirrelchat/smol-toml` — npm shorthand, and what smol-toml
 *     actually publishes — returned null, so `smol-toml: '>=1.7.1'` was audited against
 *     the global DB alone and GHSA-r4xh-jqrq-34v2 (MED, <=1.8.0, upstream-only) was
 *     missed entirely. A monorepo `/tree/main/packages/x` URL failed the same way.
 *   - `github\.com` was unanchored, so `https://evilgithub.com/a/b` yielded the slug `a/b`,
 *     which was then queried against the real api.github.com.
 *
 * Both are fixed by parsing the HOST properly and taking the FIRST two path segments.
 */
export function parseRepositoryUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // npm shorthands: "github:owner/repo" and the bare "owner/repo".
  const shorthand = /^(?:github:)?([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(trimmed);
  if (shorthand) return `${shorthand[1]!}/${shorthand[2]!}`;

  // Anything else must be a URL whose HOST is github.com, not merely a string containing
  // it. Normalize the several git transports into something `new URL` accepts.
  const normalized = trimmed
    .replace(/^git\+/, '')
    .replace(/^git@([^:/]+):/, 'https://$1/')
    .replace(/^(?:git|ssh|https?):\/\/(?:[^@/]*@)?/, 'https://');

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  if (url.hostname !== 'github.com' && !url.hostname.endsWith('.github.com')) return null;

  // First two path segments are owner and repo; a `/tree/...` or `/packages/...` tail is a
  // location INSIDE the repo, not part of its identity.
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const owner = segments[0];
  const repo = segments[1]?.replace(/\.git$/, '');
  if (!owner || !repo) return null;

  const slug = `${owner}/${repo}`;
  return SAFE_REPO_SLUG.test(slug) ? slug : null;
}

// ---------------------------------------------------------------------------
// Advisory range normalization
//
// GitHub serves vulnerable ranges in two very different dialects:
//
//   * The GLOBAL advisory DB normalizes them: ">= 8.0.0, < 8.10.2". Comma means AND.
//   * A project's OWN repo advisories are hand-authored and normalized by nobody.
//     Recorded forms across just the packages this repo pins:
//         ">= 6.7.0 < 6.28.1; 7.0.0 < 7.29.1; 8.0.0 < 8.10.2"   (`;` = OR, implied >=)
//         "< 1.1.20, >= 2.0.0 < 2.1.6, >= 3.0.0 < 3.0.8"        (comma = OR!)
//         ">= 0.40.0 && < 0.41.2"                                (`&&` = AND)
//         "> = 1.19.10 < 2.1.3"                                  (space inside operator)
//         "< 2.5.4 3.0.0 - 3.0.3 4.0.0 - 4.0.3"                  (hyphen ranges)
//         "==8.0.0", "0.6.0"                                     (exact)
//
// Comma is therefore AMBIGUOUS: AND in one dialect, OR in the other. Resolving it the
// wrong way is not a cosmetic bug. Reading the brace-expansion form as AND produces
// "<1.1.20 >=2.0.0 <2.1.6 ...", which is unsatisfiable and matches NO version, so a
// HIGH advisory would be silently dropped — the precise failure mode this whole script
// exists to prevent.
//
// The resolution is STRUCTURAL: an AND-group may carry at most one lower bound and at
// most one upper bound, so an atom whose direction the current group already has starts a
// new OR-group. Both dialects then read correctly without knowing which produced the
// string, and the failure direction is over-matching (a false finding a human notices)
// rather than under-matching (a dropped advisory nobody notices).
//
// An earlier draft grouped by SATISFIABILITY instead — extend while the group still
// describes a non-empty version set. That is subtly wrong and was caught in review. It
// holds only for ASCENDING, disjoint alternatives. For a descending list, the next
// alternative's lower bound sits BELOW the current open window, so the group stays
// satisfiable and the bound is swallowed:
//
//   ">= 3.0.0, < 5.0.7, >= 2.0.0, < 2.1.2, < 1.1.16"   (brace-expansion GHSA-3jxr-9vmj-r5cp)
//     satisfiability:  >=3.0.0 <5.0.7 >=2.0.0 || <2.1.2 <1.1.16   ← 2.x branch LOST
//     structural:      >=3.0.0 <5.0.7 || >=2.0.0 <2.1.2 || <1.1.16
//
// That advisory is HIGH and is live on juliangruber/brace-expansion today, on a package
// this repo pins. Satisfiability is still used, but only to VALIDATE each finished group.
// ---------------------------------------------------------------------------

/** Real ranges run to tens of characters; the longest observed is under 100. */
const MAX_RANGE_LENGTH = 2000;

type AtomKind = 'lower' | 'upper' | 'exact' | 'range';

interface Atom {
  kind: AtomKind;
  text: string;
}

/** Split into comparator atoms, keeping `A - B` hyphen ranges as single atoms. */
function tokenizeAtoms(group: string): Atom[] {
  // Commas and whitespace are both just separators at this point; `;` and `||` have
  // already been consumed as hard OR boundaries by the caller.
  const tokens = group
    .replace(/,/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const atoms: Atom[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    // A hyphen range: `3.0.0 - 3.0.3`. semver understands it verbatim.
    if (tokens[i + 1] === '-' && tokens[i + 2] !== undefined) {
      atoms.push({ kind: 'range', text: `${token} - ${tokens[i + 2]!}` });
      i += 2;
      continue;
    }

    // An UNSPACED hyphen range: "3.0.0-3.0.3". semver would read this as version 3.0.0
    // with the prerelease tag "3.0.3", which matches nothing once prereleases are
    // filtered out of the admitted set — a silent drop. Only treat it as a range when
    // BOTH sides are complete versions, so a real prerelease ("1.0.0-beta.1") is left be.
    const unspaced = /^(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)$/.exec(token);
    if (unspaced) {
      atoms.push({ kind: 'range', text: `${unspaced[1]!} - ${unspaced[2]!}` });
      continue;
    }

    const operator = /^(>=|<=|>|<|==|=|\^|~)/.exec(token);
    if (!operator) {
      atoms.push({ kind: 'exact', text: token });
      continue;
    }
    const symbol = operator[1]!;
    const rest = token.slice(symbol.length);
    if (symbol === '^' || symbol === '~') {
      // Keep the operator: these describe a WINDOW. Emitting the bare version made
      // `^1.2.3` match only 1.2.3 and declare 1.3.0-1.9.x clean.
      atoms.push({ kind: 'range', text: `${symbol}${rest}` });
      continue;
    }
    const kind: AtomKind = symbol.startsWith('>')
      ? 'lower'
      : symbol.startsWith('<')
        ? 'upper'
        : 'exact';
    atoms.push({ kind, text: kind === 'exact' ? rest : `${symbol}${rest}` });
  }
  return atoms;
}

/** A group describes at least one real version. `null` from minVersion means it cannot. */
function isSatisfiable(comparators: string[]): boolean {
  const range = semver.validRange(comparators.join(' '));
  if (range === null) return false;
  try {
    return semver.minVersion(range) !== null;
  } catch {
    return false;
  }
}

/**
 * Normalize a GitHub `vulnerable_version_range` into a semver range.
 *
 * Throws if the result would not be a usable range. Deliberately never returns a
 * range that matches nothing: an advisory we cannot read has to be visible, because
 * the alternative is dropping it.
 */
export function normalizeAdvisoryRange(raw: string): string {
  const cleaned = raw
    // `> =` / `< =`: operators split by stray whitespace (@hono/node-server's advisory).
    .replace(/([<>=])\s+=/g, '$1=')
    // `&&` is an AND separator; plain whitespace already means AND.
    .replace(/&&/g, ' ')
    // A comparator glued to the end of the preceding version: "3.0.0<= 3.1.0". Version
    // strings never contain `<` or `>`, so detaching them here is unambiguous.
    .replace(/([0-9A-Za-z.])(<=|>=|<|>)/g, '$1 $2')
    // Detach nothing, but glue each operator to its own version: both dialects write
    // ">= 8.0.0" with a space, which would otherwise tokenize as a bare ">=" operator
    // and a separate exact version. The `-` of a hyphen range is not in this class, so
    // "4.0.0 - 5.0.7" survives intact.
    .replace(/([<>]=?|==?|[~^])\s+/g, '$1')
    .trim();

  if (cleaned.length === 0) {
    throw new Error(`cannot parse empty vulnerable range \`${raw}\``);
  }
  // Grouping re-parses the accumulated group per atom, so cost is quadratic in the
  // comparator count. Real ranges are tens of characters; this is third-party text, and a
  // bound keeps a pathological one an error rather than a wedged job.
  if (cleaned.length > MAX_RANGE_LENGTH) {
    throw new Error(
      `vulnerable range is ${cleaned.length} characters, above the ${MAX_RANGE_LENGTH} ` +
        'this audit will parse — refusing to spend the time rather than guessing',
    );
  }

  // `;` and `||` are unambiguous OR boundaries.
  const hardGroups = cleaned.split(/\s*(?:;|\|\|)\s*/).filter((g) => g.trim().length > 0);

  const orGroups: string[][] = [];
  for (const hardGroup of hardGroups) {
    const atoms = tokenizeAtoms(hardGroup);
    if (atoms.length === 0) {
      throw new Error(`cannot parse vulnerable range \`${raw}\``);
    }

    let current: string[] = [];
    let hasLower = false;
    let hasUpper = false;
    const flush = (): void => {
      if (current.length > 0) orGroups.push(current);
      current = [];
      hasLower = false;
      hasUpper = false;
    };

    for (let i = 0; i < atoms.length; i++) {
      const atom = atoms[i]!;

      // `7.0.0 < 7.29.1`: a bare version immediately before an upper bound is an
      // implied lower bound, not an exact match.
      const impliedLower = atom.kind === 'exact' && atoms[i + 1]?.kind === 'upper';
      const comparator = impliedLower ? `>=${atom.text}` : atom.text;
      const kind: AtomKind = impliedLower ? 'lower' : atom.kind;

      // An exact version, a hyphen range, or a caret/tilde window is a complete group.
      if (kind === 'exact' || kind === 'range') {
        flush();
        orGroups.push([comparator]);
        continue;
      }

      // Two independent reasons to start a new alternative, and BOTH are needed:
      //
      //   - Structural: the group already has a bound in this direction. Catches the
      //     DESCENDING list, where `>=2.0.0` after an open `>=3.0.0 <5.0.7` window is
      //     still satisfiable and would otherwise be swallowed.
      //   - Satisfiability: joining would leave the group describing no version at all.
      //     Catches the ASCENDING list, where `>=2.0.0` after `<1.1.17` is a direction the
      //     group does not yet have but produces an empty window.
      const directionTaken = (kind === 'lower' && hasLower) || (kind === 'upper' && hasUpper);
      if (
        current.length > 0 &&
        (directionTaken || !isSatisfiable([...current, comparator]))
      ) {
        flush();
      }
      if (kind === 'lower') hasLower = true;
      else hasUpper = true;
      current.push(comparator);
    }
    flush();
  }

  if (orGroups.length === 0) {
    throw new Error(`cannot parse vulnerable range \`${raw}\``);
  }

  const range = semver.validRange(orGroups.map((g) => g.join(' ')).join(' || '));
  if (range === null) {
    throw new Error(`cannot parse vulnerable range \`${raw}\` as semver`);
  }
  // EVERY alternative must describe real versions. `.some()` here let one good group
  // excuse a dead one, so a backwards hyphen range contributed nothing and said nothing.
  const dead = orGroups.filter((group) => !isSatisfiable(group));
  if (dead.length > 0) {
    throw new Error(
      `vulnerable range \`${raw}\` normalized to \`${range}\`, in which ` +
        `\`${dead.map((g) => g.join(' ')).join('` and `')}\` matches no version`,
    );
  }
  return range;
}

/**
 * Rebuild a floor specifier around a new lower bound, preserving the original's shape
 * so the suggested fix is a drop-in replacement: `>=7.6.3 <8` -> `>=7.6.5 <8`, and a
 * caret stays a caret so its major cap survives.
 */
function renderSafeFloor(originalSpecifier: string, safeVersion: string): string {
  const tokens = originalSpecifier.trim().split(/\s+/);
  const lowerIndex = tokens.findIndex((t) => t.startsWith('>=') || t.startsWith('^'));
  if (lowerIndex === -1) {
    // No lower-bound token to rewrite (e.g. a bare `<8`); state the floor plainly.
    return `>=${safeVersion}`;
  }
  const rewritten = [...tokens];
  rewritten[lowerIndex] = tokens[lowerIndex]!.startsWith('^')
    ? `^${safeVersion}`
    : `>=${safeVersion}`;
  return rewritten.join(' ');
}

// ---------------------------------------------------------------------------
// Policy validation
// ---------------------------------------------------------------------------

const GHSA_ID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;

function validatePolicy(policy: AuditPolicy): string[] {
  const errors: string[] = [];

  policy.allowlist.forEach((entry, i) => {
    const where = `allowlist[${i}] (${entry.package || '<no package>'})`;
    if (!entry.package?.trim()) errors.push(`${where}: \`package\` is required`);
    if (!GHSA_ID.test(entry.ghsa ?? '')) {
      errors.push(
        `${where}: \`ghsa\` must be a GHSA- id (got \`${entry.ghsa}\`). A CVE id or a ` +
          'blanket wildcard is not accepted: the exception has to name one advisory so ' +
          'that a different one on the same package still fails.',
      );
    }
    if (!entry.reason?.trim()) {
      errors.push(`${where}: \`reason\` is required — an unexplained exception is a silent hole`);
    }
  });

  policy.noAdvisoryExpected.forEach((entry, i) => {
    const where = `noAdvisoryExpected[${i}] (${entry.override || '<no override>'})`;
    if (!entry.override?.trim()) errors.push(`${where}: \`override\` is required`);
    if (!entry.reason?.trim()) errors.push(`${where}: \`reason\` is required`);
  });

  return errors;
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

export async function auditOverrideFloors(options: AuditOptions): Promise<AuditReport> {
  const { policy, source } = options;

  const policyErrors = validatePolicy(policy);
  if (policyErrors.length > 0) {
    // Bail before auditing: with an invalid policy we cannot trust any suppression
    // decision, and a partial "clean" result would be worse than no result.
    return {
      checked: [],
      stale: [],
      quarantined: [],
      errors: policyErrors,
      degraded: [],
      unusedAllowlist: [],
      unusedNoAdvisoryExpected: [],
      exitCode: 1,
    };
  }

  const now = options.now ?? new Date();

  const errors: string[] = [];
  const degraded: string[] = [];
  const checked: CheckedOverride[] = [];
  const stale: StaleFloor[] = [];
  const quarantined: QuarantinedFloor[] = [];
  /** Allowlist entries observed to actually suppress a matching advisory. */
  const usedAllowlist = new Set<AllowlistEntry>();
  /** noAdvisoryExpected entries whose override genuinely returned no advisories. */
  const usedNoAdvisory = new Set<NoAdvisoryExpectedEntry>();

  let quarantineMinutes: number | null = null;
  try {
    quarantineMinutes = parseMinimumReleaseAge(options.workspaceYaml);
  } catch (err) {
    errors.push(messageOf(err));
  }

  let overrides: OverrideEntry[];
  try {
    overrides = parseOverrides(options.workspaceYaml);
  } catch (err) {
    return {
      checked: [],
      stale: [],
      quarantined: [],
      errors: [messageOf(err)],
      degraded: [],
      unusedAllowlist: policy.allowlist,
      unusedNoAdvisoryExpected: policy.noAdvisoryExpected,
      exitCode: 1,
    };
  }

  const declaredNoAdvisory = new Set(policy.noAdvisoryExpected.map((e) => e.override));

  for (const override of overrides) {
    try {
      const range = parseFloorRange(override.specifier);

      const published = await source.listVersions(override.subject);
      const admitted = published
        .filter((v) => semver.valid(v) !== null && semver.prerelease(v) === null)
        .filter((v) => semver.satisfies(v, range))
        .sort(semver.compare);

      if (admitted.length === 0) {
        // The exact symmetric case to the empty-advisory rule below. Without this the
        // script "checked" an override against nothing and printed it as sound — the
        // unaudited-entry defect its own header warns about, via an empty set rather
        // than a `continue`. A floor admitting nothing also breaks `pnpm install`.
        throw new Error(
          `floor \`${override.specifier}\` admits no published version of ` +
            `\`${override.subject}\` (excluding prereleases), so nothing was verified. ` +
            'The floor is above every release, or its bounds cross.',
        );
      }

      const advisories = await collectAdvisories(source, override.subject, (note) =>
        degraded.push(note),
      );
      if (advisories.length === 0) {
        const declared = policy.noAdvisoryExpected.find((e) => e.override === override.key);
        if (declared) usedNoAdvisory.add(declared);
      }
      if (advisories.length === 0 && !declaredNoAdvisory.has(override.key)) {
        // Every other override is advisory-motivated, so zero advisories means the
        // query returned nothing useful. Passing here is the exact silent-miss this
        // script exists to prevent, so it is an error, not a clean result.
        throw new Error(
          `no advisories returned for \`${override.subject}\`. Every override is here ` +
            'because of an advisory, so this is far more likely a failed/rate-limited ' +
            'query than a genuinely clean package. If the pin is NOT advisory-motivated, ' +
            `declare it in DEFAULT_POLICY.noAdvisoryExpected with a reason.`,
        );
      }

      // Validate every range up front so a format surprise is reported against this
      // override by name rather than mutating the verdict.
      const validated = advisories.map((advisory) => ({
        advisory,
        ranges: toSemverRanges(advisory, override.subject),
      }));

      const effective = validated.filter(({ advisory, ranges }) => {
        const match = policy.allowlist.find(
          (e) =>
            e.package === override.subject &&
            e.ghsa.toUpperCase() === advisory.ghsaId.toUpperCase(),
        );
        if (!match) return true;
        // Only count the suppression as "used" if it would otherwise have fired.
        if (admitted.some((v) => matchesAny(v, ranges))) usedAllowlist.add(match);
        return false;
      });

      const record: CheckedOverride = {
        key: override.key,
        subject: override.subject,
        currentFloor: override.specifier,
        admittedVersions: admitted,
      };
      checked.push(record);

      const implicated: ImplicatedAdvisory[] = [];
      const vulnerable = new Set<string>();
      for (const { advisory, ranges } of effective) {
        const hits = admitted.filter((v) => matchesAny(v, ranges));
        if (hits.length === 0) continue;
        implicated.push({
          ghsaId: advisory.ghsaId,
          severity: advisory.severity,
          source: advisory.source,
        });
        for (const hit of hits) vulnerable.add(hit);
      }

      if (vulnerable.size === 0) continue;

      const vulnerableVersions = [...vulnerable].sort(semver.compare);
      const highestVulnerable = vulnerableVersions[vulnerableVersions.length - 1]!;
      // Everything above the HIGHEST vulnerable version is clean by construction,
      // which is why the safe floor is derived from it rather than from any
      // advisory's first_patched_version (trap 1).
      const safeVersion = admitted.find((v) => semver.gt(v, highestVulnerable));

      const finding: StaleFloor = {
        ...record,
        vulnerableVersions,
        advisories: implicated.sort(bySeverityThenId),
        safeFloor: safeVersion ? renderSafeFloor(override.specifier, safeVersion) : null,
      };

      // Is the remedy something pnpm would actually let us install today?
      //
      // Judged over EVERY clean admitted version, not just the lowest. npm publish order
      // is not monotonic in semver order — a backport patch lands after a later minor — so
      // a quarantined `safeVersion` does not mean the floor is unraisable: pnpm skips the
      // quarantined version and resolves a higher one. Checking only `safeVersion` put an
      // actionable finding in the non-failing bucket whenever that happened.
      const cleanVersions = safeVersion
        ? admitted.filter((v) => semver.gt(v, highestVulnerable))
        : [];

      let allQuarantined = cleanVersions.length > 0 && quarantineMinutes !== null;
      // The EARLIEST expiry, and the version it belongs to. Not the latest: the floor
      // becomes raisable as soon as ANY clean version ages out, because `>=safeVersion`
      // then resolves to whichever one is mature. Reporting the latest told the maintainer
      // to wait longer than necessary while this check started failing at the earliest —
      // the report and the verdict disagreed.
      let earliestExpiry: Date | null = null;
      let earliestVersion: string | null = null;
      if (allQuarantined) {
        for (const candidate of cleanVersions) {
          let expiry: Date | null;
          try {
            expiry = await quarantineExpiry(
              source,
              override.subject,
              candidate,
              quarantineMinutes!,
              now,
            );
          } catch (err) {
            // A registry 5xx here must not destroy an already-computed finding: it used to
            // jump to the catch below and report only the HTTP error, losing the advisory
            // and the safe floor. Fail towards the actionable verdict.
            degraded.push(
              `\`${override.key}\`: could not determine quarantine status for ` +
                `${candidate} (${messageOf(err)}); reporting it as an ordinary stale floor.`,
            );
            allQuarantined = false;
            break;
          }
          if (!expiry || expiry <= now) {
            // This clean version is installable, so the floor IS raisable today.
            allQuarantined = false;
            break;
          }
          if (!earliestExpiry || expiry < earliestExpiry) {
            earliestExpiry = expiry;
            earliestVersion = candidate;
          }
        }
      }

      if (allQuarantined && finding.safeFloor && earliestExpiry && earliestVersion) {
        quarantined.push({
          ...finding,
          safeFloor: finding.safeFloor,
          // The version this timestamp actually belongs to, so the report cannot name one
          // version and quote another's window.
          safeVersion: earliestVersion,
          installableAt: earliestExpiry.toISOString(),
        });
        continue;
      }

      stale.push(finding);
    } catch (err) {
      errors.push(`override \`${override.key}\`: ${messageOf(err)}`);
    }
  }

  const unusedAllowlist = policy.allowlist.filter((e) => !usedAllowlist.has(e));
  const unusedNoAdvisoryExpected = policy.noAdvisoryExpected.filter(
    (e) => !usedNoAdvisory.has(e),
  );

  return {
    checked,
    stale,
    quarantined,
    degraded,
    unusedNoAdvisoryExpected,
    errors,
    unusedAllowlist,
    // `quarantined` is deliberately NOT a failure: see quarantineExpiry.
    exitCode: errors.length > 0 || stale.length > 0 ? 1 : 0,
  };
}

/**
 * When `version` of `pkg` ages past a `minutes`-long quarantine, or null if unknown.
 *
 * WHY THIS EXISTS. pnpm's `minimumReleaseAge` (declared in the same file this script
 * audits) refuses to resolve any version published less than that long ago, and the value
 * is verified against the COMMITTED lockfile on every `--frozen-lockfile` install — CI,
 * local installs, and the production image build. So when an upstream fix is hours old,
 * raising the floor to it does not merely fail to help: it makes `pnpm install`
 * unsatisfiable and breaks the build. There is no per-package exemption in pnpm 11.
 *
 * That makes "stale floor, remedy quarantined" a genuine third state, and the honest
 * verdict is neither pass nor fail. It exits 0 because the alternative is holding CI red
 * for up to a day over a condition nobody can act on, which trains people to ignore a red
 * run — the same "nobody notices" failure this script exists to fix. It is NOT a
 * suppression: nothing is declared by hand, the window comes from the registry's own
 * publish time and the repo's own configured value, and it expires on its own. The moment
 * the version ages out, the finding becomes an ordinary failure.
 *
 * A version whose publish time the registry does not report returns null and is therefore
 * treated as a plain stale floor. Defaulting an unknown to "quarantined" would convert
 * missing data into a free pass on a HIGH.
 */
async function quarantineExpiry(
  source: PackageDataSource,
  pkg: string,
  version: string,
  minutes: number,
  now: Date,
): Promise<Date | null> {
  const published = await source.publishedAt(pkg, version);
  if (!published) return null;
  const publishedAt = new Date(published);
  if (Number.isNaN(publishedAt.getTime())) return null;
  // A publish time in the future is corrupt registry data. The docstring already argues
  // that a MISSING timestamp must not be excused; an impossible one deserves the same,
  // and trusting it would park an actionable finding in the non-failing bucket until that
  // date arrives. `now` is passed in so this shares the audit's clock.
  if (publishedAt > now) return null;
  return new Date(publishedAt.getTime() + minutes * 60_000);
}

/**
 * Validate an advisory's vulnerable ranges into semver syntax.
 *
 * Throws on a range we cannot parse. The two tempting alternatives are both wrong:
 * treating it as "no match" silently drops the advisory (the exact silent miss this
 * script exists to catch), and treating it as "matches everything" buries the real
 * problem under a finding that claims every version is vulnerable and no safe floor
 * exists. An unparseable range is a bug in this script or a format change upstream,
 * and either way a human needs to see it named.
 */
function toSemverRanges(advisory: AdvisoryRecord, pkg: string): string[] {
  return advisory.ranges.map((raw) => {
    try {
      return normalizeAdvisoryRange(raw);
    } catch (err) {
      throw new Error(`${advisory.ghsaId} on \`${pkg}\`: ${messageOf(err)}`);
    }
  });
}

function matchesAny(version: string, ranges: string[]): boolean {
  return ranges.some((range) => semver.satisfies(version, range));
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

function bySeverityThenId(a: ImplicatedAdvisory, b: ImplicatedAdvisory): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  return bySeverity !== 0 ? bySeverity : a.ghsaId.localeCompare(b.ghsaId);
}

async function collectAdvisories(
  source: PackageDataSource,
  pkg: string,
  onDegraded: (note: string) => void,
): Promise<AdvisoryRecord[]> {
  const global = await source.globalAdvisories(pkg);

  // Trap 3: the global DB lags a project's own repo advisories.
  const slug = await source.upstreamRepo(pkg);
  if (!slug) {
    // Previously `slug ? fetch : []` with no output: the upstream-repo leg silently did
    // not run and the report still claimed every floor was sound. That is how
    // `smol-toml` (repository: "github:squirrelchat/smol-toml") lost its only advisory.
    onDegraded(
      `\`${pkg}\`: no GitHub repo resolved from its \`repository\` field, so it was ` +
        'checked against the global advisory DB only. Upstream-only advisories for this ' +
        'package cannot be seen (that is the #1933 blind spot).',
    );
  }
  let upstream: AdvisoryRecord[] = [];
  if (slug) {
    try {
      upstream = await source.repoAdvisories(slug, pkg);
    } catch (err) {
      // Only a declared coverage reduction is tolerated here. Anything else — a 403, a
      // rate limit, a network error — propagates and fails the override.
      if (!(err instanceof DegradedCoverageError)) throw err;
      onDegraded(`\`${pkg}\`: ${err.message}`);
    }
  }

  // Where both sources carry the same GHSA, the GLOBAL record wins outright and the
  // upstream copy is discarded — NOT unioned. The global DB normalizes its ranges;
  // the repo endpoint serves whatever a maintainer typed. Unioning the two means
  // re-parsing a messy restatement of a range we already have cleanly, for no gain
  // and with a real chance of mis-reading it. The repo endpoint is here for exactly
  // one job: advisories the global DB has not ingested yet (trap 3).
  const byId = new Map<string, AdvisoryRecord>();
  for (const advisory of global) {
    byId.set(advisory.ghsaId.toUpperCase(), advisory);
  }
  for (const advisory of upstream) {
    const key = advisory.ghsaId.toUpperCase();
    if (!byId.has(key)) byId.set(key, advisory);
  }
  return [...byId.values()];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatReport(report: AuditReport): string {
  const lines: string[] = [];

  if (report.errors.length > 0) {
    lines.push(`ERRORS (${report.errors.length}) — the audit did not complete:`);
    for (const error of report.errors) lines.push(`  ✗ ${error}`);
    lines.push('');
  }

  if (report.stale.length > 0) {
    lines.push(`STALE OVERRIDE FLOORS (${report.stale.length}):`);
    for (const finding of report.stale) {
      lines.push('');
      lines.push(`  ${finding.key}: '${finding.currentFloor}'`);
      lines.push(`    admits vulnerable: ${finding.vulnerableVersions.join(', ')}`);
      for (const advisory of finding.advisories) {
        const via = advisory.source === 'upstream-repo' ? ' [upstream repo only]' : '';
        lines.push(`    ${advisory.ghsaId} (${advisory.severity})${via}`);
      }
      lines.push(
        finding.safeFloor === null
          ? '    no safe floor exists within this range — every admitted version is ' +
              'vulnerable. Widen the range, drop the dependency, or declare the advisory ' +
              'in the allowlist with a reason.'
          : `    safe floor: '${finding.safeFloor}'`,
      );
    }
    lines.push('');
  }

  if (report.quarantined.length > 0) {
    lines.push(
      `BLOCKED BY MINIMUM RELEASE AGE (${report.quarantined.length}) — stale, but the fix ` +
        'is quarantined:',
    );
    for (const blocked of report.quarantined) {
      lines.push('');
      lines.push(`  ${blocked.key}: '${blocked.currentFloor}' → '${blocked.safeFloor}'`);
      lines.push(`    admits vulnerable: ${blocked.vulnerableVersions.join(', ')}`);
      for (const advisory of blocked.advisories) {
        const via = advisory.source === 'upstream-repo' ? ' [upstream repo only]' : '';
        lines.push(`    ${advisory.ghsaId} (${advisory.severity})${via}`);
      }
      lines.push(`    ${blocked.safeVersion} is installable at ${blocked.installableAt}`);
    }
    lines.push('');
    lines.push(
      '  Not counted as a failure: pnpm would refuse to resolve these versions today, so',
      '  pinning to them would break `pnpm install` rather than fix anything. Raise these',
      '  floors once the timestamps above have passed. This clears itself.',
    );
    lines.push('');
  }

  if (report.degraded.length > 0) {
    // Printed, not merely logged: this text goes into the job summary, so a green run
    // with reduced coverage is distinguishable from a green run with full coverage.
    lines.push(
      `DEGRADED COVERAGE (${report.degraded.length}) — the audit ran, but checked less than ` +
        'it should have:',
    );
    for (const note of report.degraded) lines.push(`  ! ${note}`);
    lines.push('');
  }

  if (report.unusedAllowlist.length > 0) {
    // Not a failure: an unused suppression can only ever under-suppress. It is still
    // rot worth clearing, and worth seeing before someone trusts it as live cover.
    lines.push(`UNUSED ALLOWLIST ENTRIES (${report.unusedAllowlist.length}) — safe to delete:`);
    for (const entry of report.unusedAllowlist) {
      lines.push(`  · ${entry.package} ${entry.ghsa} no longer suppresses anything`);
    }
    lines.push('');
  }

  if (report.unusedNoAdvisoryExpected.length > 0) {
    lines.push(
      `UNUSED noAdvisoryExpected ENTRIES (${report.unusedNoAdvisoryExpected.length}) — ` +
        'these overrides DO have advisories now, so the exemption is dead:',
    );
    for (const entry of report.unusedNoAdvisoryExpected) {
      lines.push(`  · ${entry.override}`);
    }
    lines.push('');
  }

  if (report.exitCode === 0) {
    if (report.quarantined.length > 0) {
      lines.push(
        `${report.checked.length} override floors checked; none is failing. ` +
          `${report.quarantined.length} ${report.quarantined.length === 1 ? 'awaits' : 'await'} ` +
          'a quarantined fix (above).',
      );
    } else if (report.degraded.length > 0) {
      // Deliberately NOT "all floors are sound": coverage was reduced, so that claim
      // would be exactly the false reassurance this script exists to remove.
      lines.push(
        `${report.checked.length} override floors checked with no failing floor, but ` +
          `${report.degraded.length} had reduced coverage (above) — this is not a clean bill.`,
      );
    } else {
      lines.push(
        `All ${report.checked.length} override floors are sound: every admitted published ` +
          'release is free of known advisories.',
      );
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Live data source
// ---------------------------------------------------------------------------

const REGISTRY = 'https://registry.npmjs.org';
const GITHUB_API = 'https://api.github.com';

/**
 * npm needs the scope separator percent-encoded: @hono/node-server -> @hono%2fnode-server.
 *
 * Validated first rather than blindly encoded. The input is a YAML key, not a name any
 * registry has vouched for, and it lands in a URL path: `foo#bar` silently queried the
 * wrong package (the fragment was dropped), `foo?x=1` became a query string, and `a/b/c`
 * only had its first slash encoded.
 */
function encodePackage(pkg: string): string {
  if (!SAFE_PACKAGE_NAME.test(pkg)) {
    throw new Error(
      `\`${pkg}\` is not a valid npm package name, so it will not be put into a registry URL`,
    );
  }
  return pkg.replace('/', '%2f');
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'curia-override-floor-audit',
  };
}

/**
 * Extract the `rel="next"` URL from a Link header, if any.
 *
 * Throws if it points anywhere but api.github.com. We re-attach the Bearer token on the
 * next request, and because this is an explicit follow rather than a 3xx redirect, undici's
 * cross-origin Authorization stripping does not apply — so nothing else would stop the
 * token being sent to whatever host the header named.
 */
function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (!match) continue;
    const next = match[1]!;
    let origin: string;
    try {
      origin = new URL(next).origin;
    } catch {
      throw new Error(`Link header rel="next" is not a URL: \`${next}\``);
    }
    if (origin !== GITHUB_API) {
      throw new Error(
        `refusing to follow Link header rel="next" to \`${origin}\` — the audit only ` +
          `paginates within ${GITHUB_API}, since the request carries a bearer token`,
      );
    }
    return next;
  }
  return null;
}

export interface RawAdvisory {
  ghsa_id?: string;
  severity?: string;
  state?: string;
  withdrawn_at?: string | null;
  vulnerabilities?: {
    package?: { ecosystem?: string; name?: string };
    vulnerable_version_range?: string;
  }[];
}

export function toAdvisoryRecords(
  raw: RawAdvisory[],
  pkg: string,
  source: AdvisoryRecord['source'],
): AdvisoryRecord[] {
  const records: AdvisoryRecord[] = [];
  for (const advisory of raw) {
    if (!advisory.ghsa_id) continue;
    // A withdrawn advisory is a retraction, not cover; a draft is not public yet.
    if (advisory.withdrawn_at) continue;
    if (advisory.state && advisory.state !== 'published') continue;

    // Ranges are carried through VERBATIM. normalizeAdvisoryRange is applied later, in
    // one place (toSemverRanges), so that a range we cannot read is reported against the
    // override that depends on it rather than throwing during the fetch.
    //
    // Two very different "no ranges" cases, which the first draft conflated by filtering
    // empty strings away here:
    //   - No `vulnerabilities` entry names `pkg`. A correct skip — this is how a monorepo
    //     advisory about a sibling package is excluded.
    //   - An entry DOES name `pkg` but carries a blank/unusable range. That is an advisory
    //     about us whose scope we cannot read, and dropping it silently is how a CRITICAL
    //     would vanish. Keep the empty string: normalizeAdvisoryRange rejects it loudly.
    const mine = (advisory.vulnerabilities ?? []).filter(
      (v) => v.package?.ecosystem?.toLowerCase() === 'npm' && v.package?.name === pkg,
    );
    if (mine.length === 0) continue;
    const ranges = mine.map((v) => (v.vulnerable_version_range ?? '').trim());

    const severity = (advisory.severity ?? 'unknown').toLowerCase();
    records.push({
      ghsaId: advisory.ghsa_id,
      // Object.hasOwn, not `in`: `in` walks the prototype chain, so 'constructor' and
      // 'toString' passed as severities and produced an undefined sort weight (NaN
      // comparator, implementation-defined order).
      severity: (Object.hasOwn(SEVERITY_ORDER, severity) ? severity : 'unknown') as Severity,
      ranges,
      source,
    });
  }
  return records;
}

export function createLiveSource(token: string): PackageDataSource {
  async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`GET ${url} -> HTTP ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /** Follow Link rel="next" so a >100-advisory package is never silently truncated. */
  async function getAllPages(firstUrl: string): Promise<RawAdvisory[]> {
    const headers = githubHeaders(token);
    const collected: RawAdvisory[] = [];
    let url: string | null = firstUrl;
    let pages = 0;
    while (url) {
      if (++pages > 20) throw new Error(`pagination did not terminate for ${firstUrl}`);
      const response = await fetch(url, { headers });
      if (!response.ok) {
        const hint =
          response.status === 403 || response.status === 429
            ? ' (rate limited — is GITHUB_TOKEN set and valid?)'
            : '';
        throw new HttpError(
          `GET ${url} -> HTTP ${response.status} ${response.statusText}${hint}`,
          response.status,
        );
      }
      const page = (await response.json()) as RawAdvisory[];
      collected.push(...page);
      url = nextLink(response.headers.get('link'));
    }
    return collected;
  }

  return {
    async listVersions(pkg) {
      // Abbreviated metadata: same full version list, a fraction of the bytes.
      const body = (await getJson(`${REGISTRY}/${encodePackage(pkg)}`, {
        Accept: 'application/vnd.npm.install-v1+json',
      })) as { versions?: Record<string, unknown> };
      const versions = Object.keys(body.versions ?? {});
      if (versions.length === 0) {
        throw new Error(`registry returned no versions for \`${pkg}\``);
      }
      return versions;
    },

    async publishedAt(pkg, version) {
      // The `time` map is only on the FULL packument, not the abbreviated one, so this is
      // a second request. It is made at most once per stale override, not per package.
      const body = (await getJson(`${REGISTRY}/${encodePackage(pkg)}`, {
        Accept: 'application/json',
      })) as { time?: Record<string, string> };
      return body.time?.[version] ?? null;
    },

    async upstreamRepo(pkg) {
      // `repository` is on the version manifest, not the abbreviated packument.
      const body = (await getJson(`${REGISTRY}/${encodePackage(pkg)}/latest`, {
        Accept: 'application/json',
      })) as { repository?: { url?: string } | string };
      const raw = typeof body.repository === 'string' ? body.repository : body.repository?.url;
      return raw ? parseRepositoryUrl(raw) : null;
    },

    async globalAdvisories(pkg) {
      const url = `${GITHUB_API}/advisories?ecosystem=npm&affects=${encodeURIComponent(pkg)}&per_page=100`;
      return toAdvisoryRecords(await getAllPages(url), pkg, 'global');
    },

    async repoAdvisories(slug, pkg) {
      if (!SAFE_REPO_SLUG.test(slug)) {
        throw new Error(`\`${slug}\` is not a valid owner/repo slug, so it will not be ` +
          'put into an api.github.com URL');
      }
      const url = `${GITHUB_API}/repos/${slug}/security-advisories?per_page=100`;
      let raw: RawAdvisory[];
      try {
        raw = await getAllPages(url);
      } catch (err) {
        // ONLY a 404 means "this repo has no advisory list". Decided on the HTTP status,
        // not by regexing the message we just formatted: `/HTTP 40[34]/` also matched the
        // rate-limit 403, so a throttled run — the likeliest failure for a script making
        // 3+ GitHub calls per override — returned [] and was indistinguishable from a
        // clean repo. The global DB still returns advisories, so the empty-list assertion
        // never fired, and the entire upstream-repo leg went quiet on a GREEN run. That
        // single 403 would have hidden the js-yaml and brace-expansion findings in this
        // very PR. 403/429 must propagate.
        if (err instanceof HttpError && err.status === 404) {
          throw new DegradedCoverageError(
            `no advisory list on \`${slug}\` (HTTP 404 — repo renamed, gone, or ` +
              'advisories disabled), so upstream-only advisories were not checked',
          );
        }
        throw err;
      }
      // This endpoint is keyed by REPO, so a monorepo hands back advisories for every
      // package it ships. toAdvisoryRecords keeps only those naming `pkg`.
      return toAdvisoryRecords(raw, pkg, 'upstream-repo');
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    // Unauthenticated GitHub allows 60 requests/hour; this audit needs well over that,
    // so running without a token fails as a rate limit part-way through. Say so now.
    console.error(
      'GITHUB_TOKEN (or GH_TOKEN) is required — the advisory API rate-limits anonymous\n' +
        'requests to 60/hour and this audit makes more than that.\n' +
        '  locally:  GITHUB_TOKEN=$(gh auth token) pnpm audit:override-floors',
    );
    process.exit(1);
  }

  const workspacePath = path.resolve(import.meta.dirname, '..', 'pnpm-workspace.yaml');
  const workspaceYaml = await readFile(workspacePath, 'utf8');

  console.log(`Auditing override floors in ${workspacePath}\n`);

  const report = await auditOverrideFloors({
    workspaceYaml,
    policy: DEFAULT_POLICY,
    source: createLiveSource(token),
  });

  const text = formatReport(report);
  console.log(text);

  // Quarantined and degraded findings exit 0, so nothing else would surface them: the
  // notify-failure job only fires on a failed run. A workflow annotation puts them on the
  // run page itself, which is the difference between "reported" and actually reported.
  if (process.env.GITHUB_ACTIONS) {
    for (const blocked of report.quarantined) {
      console.log(
        `::warning title=Stale floor awaiting a quarantined fix::${blocked.key} ` +
          `'${blocked.currentFloor}' admits ${blocked.vulnerableVersions.join(', ')} ` +
          `(${blocked.advisories.map((a) => `${a.ghsaId} ${a.severity}`).join(', ')}). ` +
          `Raise to '${blocked.safeFloor}' after ${blocked.installableAt}.`,
      );
    }
    for (const note of report.degraded) {
      console.log(`::warning title=Degraded advisory coverage::${note.replace(/\n/g, ' ')}`);
    }
  }

  // Put the verdict in the job summary so a red scheduled run is legible from the
  // Actions list without opening the log.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const { appendFile } = await import('node:fs/promises');
    const heading =
      report.exitCode !== 0
        ? '### ❌ Override floor audit failed'
        : report.quarantined.length > 0 || report.degraded.length > 0
          ? '### ⚠️ Override floors: no failure, but read this'
          : '### ✅ Override floors sound';
    // Advisory text is third-party and reaches this string; a stray ``` in it would
    // break out of the fence. A longer fence cannot be closed by one from inside.
    await appendFile(summaryPath, `${heading}\n\n~~~~\n${text.replace(/~~~~/g, '----')}\n~~~~\n`);
  }

  process.exit(report.exitCode);
}

// pathToFileURL, not `file://` concatenation: the naive form encodes some path shapes
// differently, and a mismatch would skip main() entirely — printing nothing and exiting 0.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    // Never let an unexpected throw look like a pass.
    console.error(`override-floor audit crashed: ${messageOf(err)}`);
    process.exit(1);
  });
}
