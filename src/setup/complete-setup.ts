// complete-setup.ts — finishing Setup (#2358, #2360, #2709).
//
// Marks Setup complete by storing setup.completed_at, the one key that derives the phase.
// The web thread is not rotated here: starting onboarding rotates it (OnboardingService.start),
// so an operator who finishes Setup with "Not right now" keeps their Setup chat. Idempotent.

import { markSetupComplete, type SetupWriteOptions } from './setup-settings.js';
import type { SettingsPool } from '../settings/store.js';

export async function completeSetup(pool: SettingsPool, options: SetupWriteOptions): Promise<void> {
  await markSetupComplete(pool, options);
}
