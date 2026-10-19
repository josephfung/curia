// band-policy.ts — shared pieces of band-driven autonomy (#2159).
//
// Under `autonomy.gating: band` the autonomy score decides when Curia asks first; contact
// tier only matters when an outsider is steering Curia, and the escalation judge decides
// that. See docs/wip/2026-10-15-band-driven-autonomy-design.md and ADR-049.

/** How the execution and outbound gates decide (#2159). 'tier' is the pre-#2159 policy. */
export type AutonomyGating = 'band' | 'tier';
export const AUTONOMY_GATINGS: readonly AutonomyGating[] = ['band', 'tier'];
