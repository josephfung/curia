// band-policy.ts — shared pieces of band-driven autonomy (#2159).
//
// Under `autonomy.gating: band` the autonomy score decides when Curia asks first; contact
// tier only matters when an outsider is steering Curia, and the escalation judge decides
// that. See docs/wip/2026-10-15-band-driven-autonomy-design.md and ADR-049.

/** How the execution and outbound gates decide (#2159). 'tier' is the pre-#2159 policy. */
export type AutonomyGating = 'band' | 'tier';
export const AUTONOMY_GATINGS: readonly AutonomyGating[] = ['band', 'tier'];

/** 80+ (spot-check and full): act, then tell; a judge failure sends with a report item. */
export function isSpotCheckOrAbove(score: number): boolean {
  return score >= 80;
}

/** Skills that send to a human. Gate C defers their questions to the gateway at 80+. */
export const HUMAN_SEND_SKILLS: ReadonlySet<string> = new Set([
  'email-send', 'email-reply', 'send-draft', 'signal-send', 'sms-send', 'slack-send',
]);

const DEFAULT_REVIEW_TTL_MS = 60 * 60_000;
const DEFAULT_REVIEW_MAX = 5_000;

/**
 * Tasks whose purpose and speaks-as-principal questions Gate C already asked (below 80),
 * so the gateway asks only grounding and necessity of their sends.
 *
 * In-memory: a restart forgets the marks, and the gateway then asks all four questions
 * for a send Gate C already reviewed. That costs a judge call and is never less safe.
 */
export class GateCReviews {
  private readonly marks = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_REVIEW_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_REVIEW_MAX;
    this.now = opts.now ?? Date.now;
  }

  mark(taskEventId: string): void {
    this.marks.delete(taskEventId);
    this.marks.set(taskEventId, this.now());
    // Map keeps insertion order, so the first key is the oldest.
    while (this.marks.size > this.maxEntries) {
      const oldest = this.marks.keys().next().value;
      if (oldest === undefined) break;
      this.marks.delete(oldest);
    }
  }

  wasReviewed(taskEventId: string | undefined): boolean {
    if (!taskEventId) return false;
    const at = this.marks.get(taskEventId);
    if (at === undefined) return false;
    if (this.now() - at > this.ttlMs) {
      this.marks.delete(taskEventId);
      return false;
    }
    return true;
  }
}

/**
 * Caps fail-open sends (spec: judge failure at 80+). More than `limit` in `windowMs` trips
 * it, and it stays tripped — every send holds — until a judge call succeeds.
 */
export class FailOpenLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private stamps: number[] = [];
  private tripped = false;

  constructor(opts: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.limit = opts.limit ?? 5;
    this.windowMs = opts.windowMs ?? 3_600_000;
    this.now = opts.now ?? Date.now;
  }

  /** allowed=false once tripped; justTripped is true exactly once per trip. */
  tryAcquire(): { allowed: boolean; justTripped: boolean } {
    // Once tripped, only a successful judge call clears it (spec: "until a judge call succeeds").
    if (this.tripped) return { allowed: false, justTripped: false };
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s <= this.windowMs);
    if (this.stamps.length >= this.limit) {
      this.tripped = true;
      return { allowed: false, justTripped: true };
    }
    this.stamps.push(t);
    return { allowed: true, justTripped: false };
  }

  /** A judge call succeeded: clear the trip and the window. */
  recordJudgeSuccess(): void {
    this.tripped = false;
    this.stamps = [];
  }
}
