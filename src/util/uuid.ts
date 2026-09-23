// uuid.ts — the one UUID-shape check for the whole codebase.
//
// Before this module the same "is this a real contact/node/job UUID" regex was
// declared 29 separate times across src/ and skills/ (curia#1879). Nothing was
// broken — gen_random_uuid() output passes every variant — but 29 independent
// definitions are 29 independent chances to drift, and one of them already had.
//
// ---------------------------------------------------------------------------
// The decision: LOOSE, not strict.
// ---------------------------------------------------------------------------
//
// This matcher checks *shape only*: 8-4-4-4-12 hexadecimal, case-insensitive,
// anchored. It deliberately does NOT enforce the RFC-4122 version nibble
// (position 13) or variant nibble (position 17). That means it accepts:
//
//   - v4 UUIDs, which is what `gen_random_uuid()` emits and therefore what
//     virtually every id in this system actually is;
//   - the nil UUID (all zeroes);
//   - v7 (and v6, v8) UUIDs, which are not used today but are the obvious
//     choice if we ever want time-sortable ids;
//   - any other hex string of the right shape.
//
// That is the right trade because of what these checks are *for*. Every call
// site is guarding a value that is about to be handed to Postgres as a `uuid`
// — either an id we generated, or one echoed back to us from the database, or
// an LLM-supplied argument that might be a contact *name* rather than a
// contact *id*. The job is to stop a malformed string reaching a UUID cast and
// blowing up as a 22P02 error. It is not to certify RFC conformance.
//
// Strictness buys nothing against that threat model (a strict-valid UUID that
// names no row is just as useless as a non-conforming one — the lookup fails
// either way) and costs something real: a stricter check rejects legitimate
// ids the moment one enters the system from anywhere other than
// `gen_random_uuid()`, and it fails as an unexplained 400 rather than an
// obvious error.
//
// If you ever need a genuine RFC-version check, add a separate, clearly-named
// function rather than tightening this one — tightening it silently changes
// the behaviour of every call site at once.
//
// ---------------------------------------------------------------------------
// Deliberately NOT sharing this module:
// ---------------------------------------------------------------------------
//
//   - `src/pii/scrubber.ts` uses a `\b`-bounded /g scan to *find* UUIDs inside
//     free text and redact them. Different job, different shape (unanchored,
//     stateful). It must stay separate — do not "consolidate" it here later.

/**
 * The UUID body as a pattern *string*, with no anchors and no flags, for
 * composing into larger regexes (see `src/contacts/dedup-pair-key.ts`).
 *
 * Prefer {@link isUuid} for plain "is this an id?" checks.
 */
export const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// Module-scope and stateless: no /g flag, so there is no `lastIndex` to carry
// between calls, and one compile serves every call site.
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`, 'i');

/**
 * True when `value` has the shape of a UUID and can safely be cast to a
 * Postgres `uuid`.
 *
 * Shape only — see the module header for why this is deliberately loose about
 * the RFC-4122 version and variant nibbles (v7 and the nil UUID both pass).
 *
 * Accepts `unknown` so call sites can pass LLM tool arguments straight in
 * without a typeof guard of their own.
 */
export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}
