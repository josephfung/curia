// uuid.ts — the one UUID-shape check for the whole codebase.
//
// Before this module the same "is this a real contact/node/job UUID" regex was
// declared 30 separate times across src/ and skills/ (curia#1879 — which counted
// 29, having grepped only for the `[0-9a-f]` spelling). Nothing was broken —
// gen_random_uuid() output passes every variant — but 30 independent definitions
// are 30 independent chances to drift, and two of them already had.
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
// That is the right trade because of what these checks are *for*. Most call
// sites guard a value about to be handed to Postgres as a `uuid` — either an id
// we generated, or one echoed back to us from the database, or an LLM-supplied
// argument that might be a contact *name* rather than a contact *id*. The job is
// to stop a malformed string reaching a UUID cast and blowing up as a 22P02
// error. It is not to certify RFC conformance.
//
// A handful of call sites are not SQL guards at all, and loose is right for them
// too, for their own reasons:
//
//   - `src/agents/loader.ts` and `src/scheduler/scheduler.ts` check a contact id
//     before interpolating it into model-visible prompt text. That is a
//     prompt-injection guard: what matters is that the value is an inert
//     identifier rather than arbitrary prose, which shape alone establishes. The
//     RFC version nibble tells you nothing about injection risk.
//   - `src/agents/document-placement.ts` classifies a legacy project folder-name
//     segment as "a UUID, therefore not a human-chosen slug" — again a question
//     about shape, not provenance.
//   - `src/channels/email/nylas-message-id.ts` distinguishes an outbound_context
//     entry id from a provider-native Nylas message id. Nylas ids are never
//     UUID-shaped, so shape is the whole discriminator.
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
// The complete list of UUID regexes that are NOT this module:
// ---------------------------------------------------------------------------
//
// As of #1879 there is exactly one, and it is deliberate:
//
//   - `src/pii/scrubber.ts` uses a `\b`-bounded /g scan to *find* UUIDs inside
//     free text and redact them. Different job, different shape (unanchored,
//     stateful). It must stay separate — do not "consolidate" it here later.
//
// Two files compose `UUID_PATTERN` into a larger regex rather than calling
// `isUuid()` — `src/contacts/dedup-pair-key.ts` and
// `src/scheduler/conversation-id.ts`. Those still share this source of truth.
//
// If you add another UUID regex anywhere, either import from here or add it to
// this list with a reason. The list is meant to stay exhaustive, and
// `tests/unit/uuid-single-source.test.ts` enforces that — it scans src/ and
// skills/ and fails on any new copy. That scan is what should have caught the two
// `[0-9a-fA-F]` copies #1879's own `[0-9a-f]` grep walked straight past.

/**
 * The UUID body as a pattern *string* — no anchors, no flags needed — for
 * composing into larger regexes (see `src/contacts/dedup-pair-key.ts` and
 * `src/scheduler/conversation-id.ts`).
 *
 * The hex class spells both cases (`[0-9a-fA-F]`) rather than relying on the
 * composer to add `/i`. That matters: a composed regex usually has literal text
 * around the UUID, and `/i` case-folds *that* too. `conversation-id.ts` composes
 * a `scheduler:` prefix and must keep it case-sensitive, so the pattern has to
 * carry its own case-insensitivity instead of borrowing a flag.
 *
 * Prefer {@link isUuid} for plain "is this an id?" checks.
 */
export const UUID_PATTERN =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

// Module-scope and stateless: no /g flag, so there is no `lastIndex` to carry
// between calls, and one compile serves every call site. No /i either — the
// pattern's hex class already covers both cases.
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`);

/**
 * True when `value` has the shape of a UUID and can safely be cast to a
 * Postgres `uuid`.
 *
 * Shape only — see the module header for why this is deliberately loose about
 * the RFC-4122 version and variant nibbles (v7 and the nil UUID both pass).
 *
 * Accepts `unknown` so call sites can pass LLM tool arguments straight in
 * without a typeof guard of their own, and narrows to `string` on success so a
 * guard clause (`if (!isUuid(x)) return badRequest();`) leaves `x` usable.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
