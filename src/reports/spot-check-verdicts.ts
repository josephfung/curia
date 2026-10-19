// spot-check-verdicts.ts — turn the principal's "2 bad, that was a renewal notice" into
// verdicts on the right action-log rows (#2159 Phase 3).
//
// The numbers in a digest's "Spot check" block only mean something against the digest that
// showed them. Two steps, both pure apart from the store reads:
//   1. resolveSpotCheckSet picks the digest: for an email reply, the one delivered on its
//      thread (and nothing else); for a chat reply, the most recently delivered one within 24
//      hours.
//   2. matchVerdicts maps each number to that digest's item.
//
// Neither step guesses. No matching digest, an unknown number, or a number given two
// different verdicts fails the whole call, and the record-spot-check tool writes nothing:
// a verdict on the wrong action would train the autonomy score on a grade the principal
// never gave. The error text tells the coordinator to ask the principal instead.

import type { SpotCheckItem, SpotCheckSet, SpotCheckStore } from './spot-check-store.js';

export interface SpotCheckVerdictInput {
  n: number;
  verdict: 'good' | 'bad';
  reason?: string;
}

export type ResolveSetResult = { ok: true; set: SpotCheckSet } | { ok: false; error: string };

/** How far back a chat reply may reach for the latest delivered digest. */
const FALLBACK_WINDOW_MS = 24 * 3_600_000;
const EMAIL_CONVERSATION_PREFIX = 'email:';

const NO_MATCHING_SET =
  'No spot check in the last 24 hours matches this reply. Ask the principal which action they mean; do not guess.';
const NO_SET_ON_THREAD =
  'No spot check went out on this email thread. Ask the principal which action they mean; do not guess.';

/**
 * Find the digest set a reply refers to.
 *
 * An email reply resolves only by its thread: on the digest's own thread it is unambiguous (no
 * time limit); on any other thread, "2 bad" is about that thread, not the latest digest, so it
 * fails and the coordinator asks. A chat reply (Signal, Slack, ...) has no thread to go by and
 * resolves against the latest delivered set, only within 24 hours: past that, "2 good" is too
 * likely to mean something else (spec 14). Only delivered sets resolve, so a set whose block was
 * dropped before sending (the principal never saw those numbers) can never be graded.
 *
 * Store read errors propagate: an outage must not look like "no digest found".
 */
export async function resolveSpotCheckSet(
  store: Pick<SpotCheckStore, 'findByEmailThread' | 'findLatestDelivered'>,
  where: { channelId?: string; conversationId?: string },
): Promise<ResolveSetResult> {
  const { channelId, conversationId } = where;
  if (channelId === 'email') {
    const onThread = conversationId?.startsWith(EMAIL_CONVERSATION_PREFIX)
      ? await store.findByEmailThread(conversationId.slice(EMAIL_CONVERSATION_PREFIX.length))
      : null;
    return onThread ? { ok: true, set: onThread } : { ok: false, error: NO_SET_ON_THREAD };
  }
  const latest = await store.findLatestDelivered(FALLBACK_WINDOW_MS);
  if (latest) return { ok: true, set: latest };
  return { ok: false, error: NO_MATCHING_SET };
}

/** The set's numbers as the principal saw them, for an error the coordinator can read back. */
function describeItems(set: SpotCheckSet): string {
  return set.items.map((item) => `${item.n}. ${item.summary}`).join('\n');
}

/**
 * Map each verdict to its item in `set`. All or nothing: one unknown number, or one number given
 * both "good" and "bad", fails the call so no partial set of verdicts is written.
 *
 * The same number given twice with the same verdict collapses to one match (the first reason
 * given wins), since recording it twice would only rewrite the same row.
 */
export function matchVerdicts(
  set: SpotCheckSet,
  verdicts: readonly SpotCheckVerdictInput[],
):
  | { ok: true; matched: Array<SpotCheckVerdictInput & { item: SpotCheckItem }> }
  | { ok: false; error: string } {
  const byNumber = new Map(set.items.map((item) => [item.n, item]));

  const unknown = [...new Set(verdicts.map((v) => v.n).filter((n) => !byNumber.has(n)))];
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `This spot check has no number ${unknown.join(', ')}. Its numbers are:\n${describeItems(set)}\n` +
        'Ask the principal which action they mean; do not guess. Nothing was recorded.',
    };
  }

  const matched = new Map<number, SpotCheckVerdictInput & { item: SpotCheckItem }>();
  for (const v of verdicts) {
    const prior = matched.get(v.n);
    if (prior) {
      if (prior.verdict !== v.verdict) {
        return {
          ok: false,
          error:
            `Number ${v.n} was given both good and bad. Ask the principal which they mean; do not guess. ` +
            'Nothing was recorded.',
        };
      }
      // Same verdict repeated: keep the first, but take a reason if only the repeat carried one.
      if (prior.reason === undefined && v.reason !== undefined) prior.reason = v.reason;
      continue;
    }
    // The map was checked above, so the item exists.
    matched.set(v.n, { ...v, item: byNumber.get(v.n)! });
  }
  return { ok: true, matched: [...matched.values()] };
}
