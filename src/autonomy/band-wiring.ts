// band-wiring.ts — boot-time check for band gating (#2159).
//
// Band gating reviews every send with the escalation judge. Config load already refuses
// `gating: band` with `escalation.judge.enabled: false`; this catches the rest — a judge
// that failed to wire — and logs the effective gating either way, so an operator can see
// which policy is live from the boot log.

import type { Logger } from '../logger.js';
import type { EscalationJudge } from './escalation-judge.js';
import type { AutonomyGating } from './band-policy.js';

export function checkBandGatingReady(gating: AutonomyGating, judge: EscalationJudge | undefined, logger: Logger): void {
  if (gating !== 'band') {
    logger.info({ gating }, 'Autonomy gating: tier — contact tier gates consequential actions and disclosures');
    return;
  }
  if (!judge?.isEnabled()) {
    logger.error(
      { gating },
      'band gating has no escalation judge — every send review fails: at 80+ up to 5 sends an hour go out unreviewed, the rest hold; below 80 every send holds',
    );
    return;
  }
  logger.info({ gating }, 'Autonomy gating: band — the score decides; the escalation judge reviews sends');
}
