// In-memory tracker for sign-in codes (design §5, "keeping codes out").
//
// Code values that pass through a delegated sign-in are registered here against the
// verification they belong to. The execution layer, dispatcher and checkpoint then
// scrub every string headed for storage, and the web-browser guard asks which domains
// a typed value is allowed on. Values live only in this process's memory: they are
// never written to the verifications table, to logs, or to error messages, so nothing
// in this file logs.

import { normalizeCode } from './code-shape.js';
import { registrableDomain } from './domain.js';

/** Replacement for a scrubbed code. */
export const CODE_REPLACEMENT = '[sign-in code]';

/** Values shorter than this are tracked only in their normalized form. */
const MIN_SPLIT_LEN = 6;

const MS_PER_MINUTE = 60_000;

export interface CodeTrackerOptions {
  /** How long after a verification closes its values keep being scrubbed. */
  ttlMinutesAfterClose: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

interface Tracked {
  pageDomain: string;
  values: Set<string>;
  closedAt?: Date;
  /** Compiled matcher for this verification's values; null when it has none. */
  matcher?: RegExp | null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every written form a normalized value can take: the value itself and, for values
 * of at least six characters, the value split by one space or dash at any internal
 * position ("123 456", "123-456", "G-482913").
 */
function variantsOf(value: string): string[] {
  const out = [value];
  if (value.length >= MIN_SPLIT_LEN) {
    for (let i = 1; i < value.length; i++) {
      out.push(`${value.slice(0, i)} ${value.slice(i)}`, `${value.slice(0, i)}-${value.slice(i)}`);
    }
  }
  return out;
}

/**
 * Case-insensitive matcher for a set of normalized values, on token boundaries (a
 * match may not sit inside a longer alphanumeric run). Global, so it serves
 * String.replace; use String.search for detection, which ignores lastIndex.
 */
function buildMatcher(values: Iterable<string>): RegExp | null {
  const alternatives = new Set<string>();
  for (const value of values) {
    for (const variant of variantsOf(value)) alternatives.add(escapeRegex(variant));
  }
  if (alternatives.size === 0) return null;
  // Longest first so overlapping values prefer the fuller match.
  const body = [...alternatives].sort((a, b) => b.length - a.length).join('|');
  return new RegExp(`(?<![A-Za-z0-9])(?:${body})(?![A-Za-z0-9])`, 'gi');
}

/** A page domain reduced to its registrable domain, or lowercased as given when it has none. */
function normalizeDomain(pageDomain: string): string {
  return registrableDomain(pageDomain) ?? pageDomain.trim().toLowerCase();
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export class CodeTracker {
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly byVerification = new Map<string, Tracked>();
  /** Combined matcher over every live value; undefined when it needs rebuilding. */
  private combined: RegExp | null | undefined;

  constructor(opts: CodeTrackerOptions) {
    this.ttlMs = opts.ttlMinutesAfterClose * MS_PER_MINUTE;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Track a code against a verification. The value is normalized (uppercased, one
   * internal space or dash removed); the page domain is reduced to its registrable
   * domain, or lowercased as given when it has none. Never logs the value.
   */
  register(verificationId: string, pageDomain: string, rawValue: string): void {
    const value = normalizeCode(rawValue);
    if (value === '') return;
    this.prune();
    let entry = this.byVerification.get(verificationId);
    if (!entry) {
      entry = { pageDomain: normalizeDomain(pageDomain), values: new Set() };
      this.byVerification.set(verificationId, entry);
    }
    entry.values.add(value);
    entry.matcher = undefined;
    this.combined = undefined;
  }

  /**
   * Point a verification's tracked values at a new page domain (normalized as in
   * `register`), for when a reused verification's code-entry page moved. A no-op for
   * a verification that tracks nothing.
   */
  retarget(verificationId: string, pageDomain: string): void {
    const entry = this.byVerification.get(verificationId);
    if (entry) entry.pageDomain = normalizeDomain(pageDomain);
  }

  /** Start the TTL clock for a verification's values. The first close wins. */
  closed(verificationId: string): void {
    const entry = this.byVerification.get(verificationId);
    if (entry && entry.closedAt === undefined) entry.closedAt = this.now();
  }

  /** Replace every tracked value, in any of its written forms, with `[sign-in code]`. */
  scrubText(text: string): string {
    this.prune();
    return this.scrubWith(text);
  }

  /**
   * Scrub every string in a structure of objects and arrays. Returns a new structure
   * (the input is not mutated); non-string leaves and non-plain objects are kept as is.
   */
  scrubDeep<T>(value: T): T {
    this.prune();
    return this.scrubNode(value, new WeakMap<object, unknown>()) as T;
  }

  /**
   * Page domains a text containing tracked values may be typed on: null when the text
   * contains no tracked value, otherwise the domains of every verification that tracked
   * a value found in it.
   */
  allowedDomainsFor(text: string): Set<string> | null {
    this.prune();
    let domains: Set<string> | null = null;
    for (const entry of this.byVerification.values()) {
      const matcher = this.entryMatcher(entry);
      if (matcher && text.search(matcher) !== -1) {
        domains ??= new Set();
        domains.add(entry.pageDomain);
      }
    }
    return domains;
  }

  /** Ids of the verifications that still hold tracked values (pruned first). */
  trackedIds(): string[] {
    this.prune();
    return [...this.byVerification.keys()];
  }

  /** Number of tracked values across all live verifications. */
  size(): number {
    this.prune();
    let n = 0;
    for (const entry of this.byVerification.values()) n += entry.values.size;
    return n;
  }

  private scrubNode(node: unknown, seen: WeakMap<object, unknown>): unknown {
    if (typeof node === 'string') return this.scrubWith(node);
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return seen.get(node);
    if (Array.isArray(node)) {
      const copy: unknown[] = [];
      seen.set(node, copy);
      for (const item of node) copy.push(this.scrubNode(item, seen));
      return copy;
    }
    if (!isPlainObject(node)) return node;
    const copy: Record<string, unknown> = {};
    seen.set(node, copy);
    for (const [key, item] of Object.entries(node)) copy[key] = this.scrubNode(item, seen);
    return copy;
  }

  private scrubWith(text: string): string {
    const matcher = this.combinedMatcher();
    return matcher ? text.replace(matcher, CODE_REPLACEMENT) : text;
  }

  private combinedMatcher(): RegExp | null {
    if (this.combined === undefined) {
      const values: string[] = [];
      for (const entry of this.byVerification.values()) values.push(...entry.values);
      this.combined = buildMatcher(values);
    }
    return this.combined;
  }

  private entryMatcher(entry: Tracked): RegExp | null {
    if (entry.matcher === undefined) entry.matcher = buildMatcher(entry.values);
    return entry.matcher;
  }

  /** Drop verifications whose TTL has run out since they closed. */
  private prune(): void {
    const nowMs = this.now().getTime();
    for (const [id, entry] of this.byVerification) {
      if (entry.closedAt !== undefined && nowMs - entry.closedAt.getTime() >= this.ttlMs) {
        this.byVerification.delete(id);
        this.combined = undefined;
      }
    }
  }
}
