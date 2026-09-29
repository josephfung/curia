#!/usr/bin/env tsx
// scripts/audit-override-floors.ts
//
// Assert that every `overrides:` floor in pnpm-workspace.yaml is SOUND: that every
// published release the floor admits is free of known advisories. #1934.
//
// Run locally:  GITHUB_TOKEN=$(gh auth token) pnpm audit:override-floors
// Run in CI:    .github/workflows/override-floor-audit.yml (weekly + on workspace edits)
//
// Exit codes: 0 = every floor sound, 1 = a stale floor, a parse error, or an API failure.
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
//      We therefore query BOTH sources and union them.
//
// This is not a replacement for Dependabot. Dependabot answers "is the tree I resolved
// vulnerable"; this answers "would my floors still protect me if resolution moved".

import { readFile } from 'node:fs/promises';
import path from 'node:path';
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

export interface AuditReport {
  checked: CheckedOverride[];
  stale: StaleFloor[];
  /** Hard failures: unparseable entries, API errors, undeclared empty advisory sets. */
  errors: string[];
  /** Allowlist entries that no longer suppress anything. Housekeeping, not a failure. */
  unusedAllowlist: AllowlistEntry[];
  exitCode: 0 | 1;
}

export interface AuditOptions {
  workspaceYaml: string;
  policy: AuditPolicy;
  source: PackageDataSource;
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
  const range = semver.validRange(specifier);
  if (range === null) {
    throw new Error(`cannot parse version specifier \`${specifier}\` as a semver range`);
  }
  return range;
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
// The resolution is to group by SATISFIABILITY rather than by separator: keep adding
// comparators to the current AND-group while the group still describes a non-empty set
// of versions, and start a new OR-group when it would not. That reads both dialects
// correctly without having to know which one produced the string.
// ---------------------------------------------------------------------------

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
    const operator = /^(>=|<=|>|<|==|=|\^|~)/.exec(token);
    if (!operator) {
      atoms.push({ kind: 'exact', text: token });
      continue;
    }
    const symbol = operator[1]!;
    const rest = token.slice(symbol.length);
    const kind: AtomKind = symbol.startsWith('>')
      ? 'lower'
      : symbol.startsWith('<')
        ? 'upper'
        : 'exact';
    atoms.push({ kind, text: kind === 'exact' ? rest : `${symbol === '==' ? '=' : symbol}${rest}` });
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

  // `;` and `||` are unambiguous OR boundaries.
  const hardGroups = cleaned.split(/\s*(?:;|\|\|)\s*/).filter((g) => g.trim().length > 0);

  const orGroups: string[][] = [];
  for (const hardGroup of hardGroups) {
    const atoms = tokenizeAtoms(hardGroup);
    if (atoms.length === 0) {
      throw new Error(`cannot parse vulnerable range \`${raw}\``);
    }

    let current: string[] = [];
    const flush = (): void => {
      if (current.length > 0) orGroups.push(current);
      current = [];
    };

    for (let i = 0; i < atoms.length; i++) {
      const atom = atoms[i]!;

      // `7.0.0 < 7.29.1`: a bare version immediately before an upper bound is an
      // implied lower bound, not an exact match.
      const impliedLower = atom.kind === 'exact' && atoms[i + 1]?.kind === 'upper';
      const comparator = impliedLower ? `>=${atom.text}` : atom.text;
      const kind: AtomKind = impliedLower ? 'lower' : atom.kind;

      // An exact version or a hyphen range is a complete group on its own.
      if (kind === 'exact' || kind === 'range') {
        flush();
        orGroups.push([comparator]);
        continue;
      }

      // Otherwise extend the current group only while it stays satisfiable — this is
      // what disambiguates comma-as-AND from comma-as-OR without guessing.
      if (current.length > 0 && !isSatisfiable([...current, comparator])) {
        flush();
      }
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
  // A range that matches nothing would silently absolve every version.
  if (!orGroups.some((group) => isSatisfiable(group))) {
    throw new Error(
      `vulnerable range \`${raw}\` normalized to \`${range}\`, which matches no version`,
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
      errors: policyErrors,
      unusedAllowlist: [],
      exitCode: 1,
    };
  }

  const errors: string[] = [];
  const checked: CheckedOverride[] = [];
  const stale: StaleFloor[] = [];
  /** Allowlist entries observed to actually suppress a matching advisory. */
  const usedAllowlist = new Set<AllowlistEntry>();

  let overrides: OverrideEntry[];
  try {
    overrides = parseOverrides(options.workspaceYaml);
  } catch (err) {
    return {
      checked: [],
      stale: [],
      errors: [messageOf(err)],
      unusedAllowlist: policy.allowlist,
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

      const advisories = await collectAdvisories(source, override.subject);
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

      stale.push({
        ...record,
        vulnerableVersions,
        advisories: implicated.sort(bySeverityThenId),
        safeFloor: safeVersion ? renderSafeFloor(override.specifier, safeVersion) : null,
      });
    } catch (err) {
      errors.push(`override \`${override.key}\`: ${messageOf(err)}`);
    }
  }

  const unusedAllowlist = policy.allowlist.filter((e) => !usedAllowlist.has(e));

  return {
    checked,
    stale,
    errors,
    unusedAllowlist,
    exitCode: errors.length > 0 || stale.length > 0 ? 1 : 0,
  };
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
): Promise<AdvisoryRecord[]> {
  const global = await source.globalAdvisories(pkg);

  // Trap 3: the global DB lags a project's own repo advisories.
  const slug = await source.upstreamRepo(pkg);
  const upstream = slug ? await source.repoAdvisories(slug, pkg) : [];

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

  if (report.unusedAllowlist.length > 0) {
    // Not a failure: an unused suppression can only ever under-suppress. It is still
    // rot worth clearing, and worth seeing before someone trusts it as live cover.
    lines.push(`UNUSED ALLOWLIST ENTRIES (${report.unusedAllowlist.length}) — safe to delete:`);
    for (const entry of report.unusedAllowlist) {
      lines.push(`  · ${entry.package} ${entry.ghsa} no longer suppresses anything`);
    }
    lines.push('');
  }

  if (report.exitCode === 0) {
    lines.push(
      `All ${report.checked.length} override floors are sound: every admitted published ` +
        'release is free of known advisories.',
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Live data source
// ---------------------------------------------------------------------------

const REGISTRY = 'https://registry.npmjs.org';
const GITHUB_API = 'https://api.github.com';

/** npm needs the scope separator percent-encoded: @hono/node-server -> @hono%2fnode-server. */
function encodePackage(pkg: string): string {
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

/** Extract the `rel="next"` URL from a Link header, if any. */
function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1]!;
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
    const ranges = (advisory.vulnerabilities ?? [])
      .filter((v) => v.package?.ecosystem?.toLowerCase() === 'npm' && v.package?.name === pkg)
      .map((v) => (v.vulnerable_version_range ?? '').trim())
      .filter((r) => r.length > 0);
    if (ranges.length === 0) continue;

    const severity = (advisory.severity ?? 'unknown').toLowerCase();
    records.push({
      ghsaId: advisory.ghsa_id,
      severity: (severity in SEVERITY_ORDER ? severity : 'unknown') as Severity,
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
        throw new Error(`GET ${url} -> HTTP ${response.status} ${response.statusText}${hint}`);
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

    async upstreamRepo(pkg) {
      // `repository` is on the version manifest, not the abbreviated packument.
      const body = (await getJson(`${REGISTRY}/${encodePackage(pkg)}/latest`, {
        Accept: 'application/json',
      })) as { repository?: { url?: string } | string };
      const raw = typeof body.repository === 'string' ? body.repository : body.repository?.url;
      if (!raw) return null;
      const match = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?$/.exec(raw);
      return match ? `${match[1]}/${match[2]}` : null;
    },

    async globalAdvisories(pkg) {
      const url = `${GITHUB_API}/advisories?ecosystem=npm&affects=${encodeURIComponent(pkg)}&per_page=100`;
      return toAdvisoryRecords(await getAllPages(url), pkg, 'global');
    },

    async repoAdvisories(slug, pkg) {
      const url = `${GITHUB_API}/repos/${slug}/security-advisories?per_page=100`;
      let raw: RawAdvisory[];
      try {
        raw = await getAllPages(url);
      } catch (err) {
        // A repo with advisories disabled, renamed, or gone answers 404/403. That is
        // not an audit failure — the global DB still covers the package — but it must
        // not be mistaken for "no advisories", so we say so and move on.
        const message = messageOf(err);
        if (/HTTP 40[34]/.test(message)) {
          console.warn(`  note: no readable repo advisories for ${slug} (${message})`);
          return [];
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

  // Put the verdict in the job summary so a red scheduled run is legible from the
  // Actions list without opening the log.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const { appendFile } = await import('node:fs/promises');
    const heading =
      report.exitCode === 0
        ? '### ✅ Override floors sound'
        : '### ❌ Override floor audit failed';
    await appendFile(summaryPath, `${heading}\n\n\`\`\`\n${text}\n\`\`\`\n`);
  }

  process.exit(report.exitCode);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err: unknown) => {
    // Never let an unexpected throw look like a pass.
    console.error(`override-floor audit crashed: ${messageOf(err)}`);
    process.exit(1);
  });
}
