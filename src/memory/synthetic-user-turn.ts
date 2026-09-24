// Synthetic `role = 'user'` turns — rows Curia wrote to itself (#1892).
//
// Several code paths re-enter an agent by writing a task brief that lands in
// working_memory as a `user` turn with a null sender: the voice opening cue, the
// outbound content-filter rewrite brief, a late specialist result, and the
// secret-capture resume. They are indistinguishable from an unattributed human
// message once stored, and two readers need the difference:
//
//   1. The contact-recent shared-conversation check (`contact-recent-history.ts`)
//      reads an unattributed user row as another participant and closes that
//      conversation to recall — permanently, since the check has no time or
//      archived filter.
//   2. The Signal/SMS sender backfill (`direct-sender-backfill.ts`) stamps rows
//      by conversation-id pattern alone, and would attribute these to the human
//      peer. Recall would then surface Curia's own control messages as that
//      person's words.
//
// Live rows do NOT use this module. The writer knows what it minted, so it says
// so: `agent.task` carries `syntheticTurn`, the runtime forwards it to
// `addTurn`, and it lands in `working_memory.synthetic`. The voice opening cue
// never publishes `agent.task`; VoiceRuntime sets the same column on the cue's
// `addTurn`. Both readers test that column. An unregistered path defaults to
// false, which means "treat as a participant" — the fail-closed direction.
//
// What lives here is the ONE job content matching is still fit for: classifying
// rows stored before the column existed (migration 092). Matching on content is
// a lossy reconstruction of a fact the writer had and discarded, and lossy in
// the dangerous direction — an inbound message that happens to open with a known
// marker would be dropped from the shared check, letting assistant replies that
// quote that person reach another contact's recall block. Message bodies are
// attacker-controlled, so as a standing predicate that is an audience-leak
// surface. As a one-time pass over rows nobody can still influence, it is a
// bounded and inspectable event.
//
// Adding a synthetic turn type therefore means setting `syntheticTurn` at its
// publish site, or `synthetic: true` on a direct `addTurn`. It needs an entry
// here only if rows of that shape are already stored, and then it needs its own
// migration — 092 cannot be edited once run.

import { VOICE_GREETING_USER_MESSAGE } from '../channels/voice/greeting.js';

/**
 * Opening line of the rewrite brief built by `buildContentBlockRewriteTask`
 * (`src/dispatch/content-block-relay.ts`), which imports it from here so the
 * builder and the historical pattern below cannot drift.
 */
export const CONTENT_BLOCK_REWRITE_MARKER = '[OUTBOUND CONTENT FILTER — REWRITE REQUIRED]';

/**
 * Opening of the brief built by `buildLateResultBrief`
 * (`src/agents/late-delegation.ts`), up to the interpolated agent name. The full
 * line reads `[Late specialist result — <agent>, delivered <timestamp>]`.
 */
export const LATE_SPECIALIST_RESULT_MARKER = '[Late specialist result — ';

/**
 * Bindable SQL `LIKE` patterns that classify already-stored synthetic turns.
 * Migration 092 is checked against these. Apostrophes are literal here: a
 * caller binding the pattern passes it as a parameter. The migration doubles
 * them (`'` → `''`) only because the same text sits inside a SQL string literal.
 *
 * Deliberately patterns rather than prefixes: the secret-capture resume briefs
 * (`src/secrets/secret-capture-resume-subscriber.ts`) are ordinary prose that
 * was never written to be recognized, and interpolate the secret's display name
 * in the middle. `'The secret '` alone would be far too broad to use as a
 * predicate — the surrounding text is what makes these specific.
 *
 * Every pattern is anchored at the start of the content. None is used on a live
 * row.
 */
export const HISTORICAL_SYNTHETIC_LIKE_PATTERNS: readonly string[] = [
  `${VOICE_GREETING_USER_MESSAGE}%`,
  `${CONTENT_BLOCK_REWRITE_MARKER}%`,
  `${LATE_SPECIALIST_RESULT_MARKER}%`,
  // Both secret-capture variants, which diverge after the display name.
  "The secret '%' was just captured and saved to the vault.%",
  "The secret '%' that a specialist asked for was just captured and saved to the vault.%",
];
