// relay-budget.ts — caps the immediate messages to the principal an outsider can cause (#1320).
//
// An external contact who writes to Curia again and again can get the coordinator to message
// the principal each time. Sends to the principal alone skip the band review (nobody else reads
// them) and Gate C's tier rules allow them, so nothing else limits that. The gateway asks this
// budget before such a send; over budget, the relay goes to the principal's digest instead.
//
// In memory only: a restart resets the counts, and an outsider cannot cause a restart.
// See docs/wip/2026-10-19-relay-budget-design.md and spec 14 (Relay budget).

import type { TaskOriginator } from '../contacts/types.js';

/** The budget's window: relays are counted over the last hour. */
export const RELAY_BUDGET_WINDOW_MS = 3_600_000;

/** Tiers whose relays are budgeted. A missing tier is treated as 'unknown' (#1059 fails closed). */
const BUDGETED_TIERS: ReadonlySet<string> = new Set(['known', 'unknown', 'blocked']);

/**
 * The originator to count this send against, or null when it is not budgeted. Sends the
 * principal approved or directed, and system notifications (approvals, notices), are never
 * budgeted; nor is work the principal, the system or an agent started, or a trusted contact's.
 * The caller checks separately that the principal is the sole recipient.
 */
export function budgetedOriginator(
  options: {
    isSystemNotification?: boolean;
    humanApproved?: boolean;
    principalDirected?: boolean;
    originator?: TaskOriginator;
  } | undefined,
): TaskOriginator | null {
  if (!options?.originator) return null;
  if (options.isSystemNotification || options.humanApproved || options.principalDirected) return null;
  const { systemRole } = options.originator;
  if (systemRole === 'principal' || systemRole === 'system' || systemRole === 'agent') return null;
  return BUDGETED_TIERS.has(options.originator.tier ?? 'unknown') ? options.originator : null;
}

/**
 * A sliding one-hour window of relay timestamps per originator contact id. Modelled on
 * FailOpenLimiter (band-policy.ts) for the window and on the inbound RateLimiter (#1665) for
 * evicting originators that have gone quiet, so the maps never grow without bound.
 */
export class RelayBudget {
  private readonly perHour: number;
  private readonly now: () => number;
  private readonly stamps = new Map<string, number[]>();
  /** When each originator's last "holding them for your digest" notice went out. */
  private readonly notices = new Map<string, number>();
  private lastSweepAt = 0;

  constructor(opts: { perHour: number; now?: () => number }) {
    if (!Number.isInteger(opts.perHour) || opts.perHour < 0) {
      throw new Error(`RelayBudget: perHour must be a non-negative integer, got ${String(opts.perHour)}`);
    }
    this.perHour = opts.perHour;
    this.now = opts.now ?? Date.now;
  }

  /** Records the relay and returns 'allowed', or returns 'over' and records nothing. */
  tryAcquire(contactId: string): 'allowed' | 'over' {
    if (this.perHour === 0) return 'allowed'; // budget switched off
    const t = this.now();
    this.sweep(t);
    const live = this.live(contactId, t);
    if (live.length >= this.perHour) {
      this.stamps.set(contactId, live);
      return 'over';
    }
    live.push(t);
    this.stamps.set(contactId, live);
    return 'allowed';
  }

  /**
   * True for the first over-budget relay in a window: the principal gets one line saying more
   * updates are waiting in the digest. False again until a full window has passed.
   */
  shouldNotify(contactId: string): boolean {
    const t = this.now();
    const last = this.notices.get(contactId);
    if (last !== undefined && t - last < RELAY_BUDGET_WINDOW_MS) return false;
    this.notices.set(contactId, t);
    return true;
  }

  /** Relays counted for this originator in the current window. */
  count(contactId: string): number {
    return this.live(contactId, this.now()).length;
  }

  /** Originators currently tracked (either map). For tests of the eviction sweep. */
  trackedCount(): number {
    return new Set([...this.stamps.keys(), ...this.notices.keys()]).size;
  }

  private live(contactId: string, t: number): number[] {
    return (this.stamps.get(contactId) ?? []).filter((s) => t - s < RELAY_BUDGET_WINDOW_MS);
  }

  /** At most once per window: drop originators with no relay or notice inside the window. */
  private sweep(t: number): void {
    if (t - this.lastSweepAt < RELAY_BUDGET_WINDOW_MS) return;
    this.lastSweepAt = t;
    for (const [id, stamps] of this.stamps) {
      const live = stamps.filter((s) => t - s < RELAY_BUDGET_WINDOW_MS);
      if (live.length === 0) this.stamps.delete(id);
      else this.stamps.set(id, live);
    }
    for (const [id, at] of this.notices) {
      if (t - at >= RELAY_BUDGET_WINDOW_MS) this.notices.delete(id);
    }
  }
}
