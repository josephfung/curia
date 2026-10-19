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

/** Skills that send to a human. Gate C leaves their review to the gateway's band review. */
export const HUMAN_SEND_SKILLS: ReadonlySet<string> = new Set([
  'email-send', 'email-reply', 'send-draft', 'signal-send', 'sms-send', 'slack-send',
]);

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

  /**
   * A judge call succeeded. If the cap had tripped, the reviewer is back: clear the trip and
   * start a fresh window. Otherwise keep the count — a judge that fails intermittently (say,
   * truncating only long messages) must still trip the cap, not reset it on every success.
   */
  recordJudgeSuccess(): void {
    if (!this.tripped) return;
    this.tripped = false;
    this.stamps = [];
  }

  /** True while sends hold for want of a reviewer. In memory: a restart clears it. */
  isTripped(): boolean {
    return this.tripped;
  }
}
