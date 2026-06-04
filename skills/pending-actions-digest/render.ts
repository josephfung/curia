// render.ts — pure formatting for the pending-actions-digest email body.
//
// No I/O and no clock reads: the current time is injected as `nowMs` so every
// function is deterministic and snapshot-testable. The handler supplies
// `Date.now()` at call time (which test suites pin via vi.spyOn).

const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;
const MS_WEEK = 604_800_000;
const MS_TWO_WEEKS = 14 * MS_DAY;

/**
 * Short humanized age of an ISO timestamp relative to nowMs.
 * Buckets: <1h, Nh (<1 day), Nd (<2 weeks), Nw (>=2 weeks).
 * Future or zero spans clamp to '<1h'.
 */
export function humanizeAge(sinceIso: string, nowMs: number): string {
  const diff = nowMs - Date.parse(sinceIso);
  if (!Number.isFinite(diff) || diff < MS_HOUR) return '<1h';
  if (diff < MS_DAY) return `${Math.floor(diff / MS_HOUR)}h`;
  if (diff < MS_TWO_WEEKS) return `${Math.floor(diff / MS_DAY)}d`;
  return `${Math.floor(diff / MS_WEEK)}w`;
}
