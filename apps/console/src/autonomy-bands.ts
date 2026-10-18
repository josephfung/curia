// autonomy-bands.ts — the autonomy bands as the console shows them. Shared by Settings →
// Autonomy (slider) and the setup wizard (band picker), so both name and describe the
// bands the same way. Thresholds mirror src/autonomy/autonomy-service.ts.

export type AutonomyBand = 'full' | 'spot-check' | 'approval-required' | 'draft-only' | 'restricted';

// Band colors match the legacy UI and the app's design token palette.
export const BAND_META: Record<AutonomyBand, { label: string; color: string; description: string }> = {
  'full':              { label: 'Full',              color: '#5E9E6B', description: 'Curia acts independently with no confirmation required for any standard operation.' },
  'spot-check':        { label: 'Spot-check',        color: '#6BAED6', description: 'Curia proceeds with most actions and flags a small random sample for your review.' },
  'approval-required': { label: 'Approval Required', color: '#C9874A', description: 'Curia carries out your direct instructions, and asks before acting on its own initiative.' },
  'draft-only':        { label: 'Draft Only',        color: '#7E6BA8', description: 'Curia prepares drafts and summaries but does not send, schedule, or commit anything.' },
  'restricted':        { label: 'Restricted',        color: '#E86040', description: 'Curia operates in read-only mode. No writes, sends, or external actions.' },
};

/** Least to most independent: the order a picker lists them in. */
export const BAND_ORDER: readonly AutonomyBand[] = ['restricted', 'draft-only', 'approval-required', 'spot-check', 'full'];

// Each band's lowest score.
const BAND_FLOOR: Record<AutonomyBand, number> = {
  'full': 90,
  'spot-check': 80,
  'approval-required': 70,
  'draft-only': 60,
  'restricted': 0,
};

export function bandForScore(score: number): AutonomyBand {
  if (score >= BAND_FLOOR['full']) return 'full';
  if (score >= BAND_FLOOR['spot-check']) return 'spot-check';
  if (score >= BAND_FLOOR['approval-required']) return 'approval-required';
  if (score >= BAND_FLOOR['draft-only']) return 'draft-only';
  return 'restricted';
}

/**
 * The score a picked band saves as: its lower bound, so a band never unlocks an
 * `action_risk` tier above what its name suggests.
 */
export function scoreForBand(band: AutonomyBand): number {
  return BAND_FLOOR[band];
}
