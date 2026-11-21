// complete-setup.ts — finishing Setup (#2358, #2360).
//
// Marks Setup complete. The web thread is not rotated here: starting onboarding rotates it
// (OnboardingService.start), so an operator who finishes Setup with "Not right now" keeps
// their Setup chat. Idempotent.

import type { SetupStateQueryable } from './setup-state.js';
import { markSetupComplete } from './setup-state.js';

export async function completeSetup(db: SetupStateQueryable): Promise<void> {
  await markSetupComplete(db);
}
