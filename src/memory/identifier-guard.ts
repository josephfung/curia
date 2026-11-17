// identifier-guard.ts — keeps labels that carry different identifiers apart.
//
// Embedding similarity cannot tell "Order #418-5530217-6094412" from
// "Order #418-5530217-6094512": the text is near-identical, the vectors are too,
// and a one-digit difference is a different order. Resolving or merging such
// labels corrupts the knowledge graph, so the fuzzy-resolve and fact-dedup
// paths consult this guard before trusting a similarity score. It is
// model-independent: it looks at the strings, not the vectors.

import { UUID_PATTERN } from '../util/uuid.js';

// Separators allowed INSIDE a number: they are deleted when they sit between
// digits, so "(519) 555-0142" and "519-555-0142" tokenise identically, and so
// do order numbers written with dashes. The set covers phone/order formatting
// (- . , spaces parentheses) plus ":" and "/" so ISO timestamps split into a
// date token and a time token ("2031-08-09T14:15:00" -> 20310809, 141500).
// Without ":" a start_time and end_time on the same day would tokenise
// identically and the guard would miss that they differ.
const DIGIT_RUN = /\d+(?:[\s\-.,:/()]+\d+)*/g;

// Alphanumeric ids (message ids, hashes). Must contain a digit so ordinary
// long words ("Corporation") are not treated as identifiers.
const ALNUM_RUN = /[a-z0-9]{8,}/g;

// A whole UUID (message ids, record ids). ALNUM_RUN sees only its 8- and 12-character
// groups, so two UUIDs differing in a middle group would tokenise identically; the whole
// value, dashes dropped, is the token that tells them apart.
const UUID = new RegExp(UUID_PATTERN, 'g');

// Digit runs shorter than this are quantities/years-in-prose/"Q3", not ids.
const MIN_DIGITS = 4;

// A bare four-digit run in this range reads as a year. Written with a separator
// ("19:30") it is a clock time or part of a number, so only a run with nothing
// between its digits counts.
const YEAR = /^(?:19|20)\d\d$/;

/**
 * How strictly a token must match the other label's:
 * - `digits`: exactly, as a whole token. "52817" and "528170" are different numbers.
 * - `alnum` (letters and digits): exactly, or through mutual containment with a
 *   token of the other label: the other token contains this one, and the other
 *   token appears in this label's text once punctuation is removed.
 *   "pennyharlow7@mailbox.test" written as "pennyharlow7mailbox.test" is the same
 *   address with the @ dropped: "pennyharlow7mailbox" contains "pennyharlow7" and
 *   is itself in "pennyharlow7mailboxtest". "pennyharlow72" also contains
 *   "pennyharlow7" but is not in that text, so a prefix-extended id stays apart.
 * - `year`: context rather than an identifier; see hasConflictingIdentifiers.
 */
type TokenKind = 'digits' | 'alnum' | 'year';

function classifyTokens(label: string): Map<string, TokenKind> {
  const tokens = new Map<string, TokenKind>();
  const lower = label.toLowerCase();

  for (const run of lower.match(DIGIT_RUN) ?? []) {
    const digits = run.replace(/\D/g, '');
    if (digits.length < MIN_DIGITS) continue;
    const kind: TokenKind = YEAR.test(run) ? 'year' : 'digits';
    // The same value seen as a year once and as a plain number elsewhere is a number:
    // the stricter reading wins.
    if (tokens.get(digits) !== 'digits') tokens.set(digits, kind);
  }
  for (const run of lower.match(ALNUM_RUN) ?? []) {
    if (!/\d/.test(run)) continue;
    // A pure-digit run is a number, matched exactly like one.
    const kind: TokenKind = /[a-z]/.test(run) ? 'alnum' : 'digits';
    if (!tokens.has(run) || kind === 'digits') tokens.set(run, kind);
  }
  for (const uuid of lower.match(UUID) ?? []) {
    const value = uuid.replace(/-/g, '');
    // An all-digit UUID is already a digits token from DIGIT_RUN; only add the alnum form.
    if (!tokens.has(value)) tokens.set(value, 'alnum');
  }
  return tokens;
}

/** Extract the identifier-like tokens of a label (digit runs and alphanumeric ids). */
export function extractIdentifierTokens(label: string): Set<string> {
  return new Set(classifyTokens(label).keys());
}

/** The label lower-cased with everything but letters and digits removed. */
function squash(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * True when every token of `from` is present in the other label. `fromSquashed`
 * is the squashed text of the label `from` came from: an alnum token found only
 * inside a longer token of the other label counts as present when that longer
 * token is spelled out in `from`'s own text too, so the difference between the
 * two is punctuation and nothing else.
 */
function allPresent(from: Map<string, TokenKind>, other: Map<string, TokenKind>, fromSquashed: string): boolean {
  for (const [value, kind] of from) {
    if (other.has(value)) continue;
    if (kind === 'alnum' && [...other.keys()].some(o => o.includes(value) && fromSquashed.includes(o))) continue;
    return false;
  }
  return true;
}

function withoutYears(tokens: Map<string, TokenKind>): Map<string, TokenKind> {
  return new Map([...tokens].filter(([, kind]) => kind !== 'year'));
}

/**
 * True when both labels carry identifiers and neither identifier set is a
 * subset of the other.
 *
 * A subset counts as compatible: one label often restates the other with extra
 * context ("tax: $1,204.50" vs "tax: $1,204.50 (no change since 2030)"), which
 * is the same fact. Two sets that each hold something the other lacks name
 * different things. A label with no identifiers never conflicts, so plain
 * prose ("Acme Corp" vs "Acme Corporation") is left to the embedding score.
 *
 * Years are weaker than other identifiers. When both labels carry something
 * stronger (an amount, a date, an order number), the years are set aside, so a
 * year in an attribute name or a "(same as 2030)" aside does not veto a match
 * on the amount. When either label has only years, the years decide, so
 * "Q2 2031 board meeting" and "Q2 2032 board meeting" stay apart.
 * Calibration on the maintainer's labelled set (#2023) found both this and the
 * dropped-@ case among pairs labelled the same.
 */
export function hasConflictingIdentifiers(a: string, b: string): boolean {
  let ta = classifyTokens(a);
  let tb = classifyTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;

  const strongA = withoutYears(ta);
  const strongB = withoutYears(tb);
  if (strongA.size > 0 && strongB.size > 0) {
    ta = strongA;
    tb = strongB;
  }

  const aInB = allPresent(ta, tb, squash(a));
  const bInA = allPresent(tb, ta, squash(b));
  return !aInB && !bInA;
}
