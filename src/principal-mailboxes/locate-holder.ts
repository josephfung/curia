// locate-holder.ts — decide which mailbox holds an object once every candidate has been asked
// (#2475, D2/D6). The skills' `locate` (skills/_shared/principal-mailbox-client.ts) and the
// outbound gateway's send path both ask their own clients, then judge the answers here, so the
// rules cannot drift: exactly one hit is the holder; two or more is ambiguous (never guess);
// no hit is a miss, and a candidate that failed (not a 404) means the miss is not definitive.

/** What asking one mailbox for the object returned: it holds it, 404, or the ask failed. */
export type HolderOutcome = 'hit' | 'miss' | 'failed';

export type HolderVerdict<T> =
  | { kind: 'found'; holder: T }
  | { kind: 'ambiguous'; holders: T[] }
  | { kind: 'not_found'; failed: T[] };

export function judgeHolders<T>(results: ReadonlyArray<{ candidate: T; outcome: HolderOutcome }>): HolderVerdict<T> {
  const hits = results.filter((r) => r.outcome === 'hit');
  if (hits.length === 1) return { kind: 'found', holder: hits[0]!.candidate };
  if (hits.length > 1) return { kind: 'ambiguous', holders: hits.map((h) => h.candidate) };
  return { kind: 'not_found', failed: results.filter((r) => r.outcome === 'failed').map((r) => r.candidate) };
}
