// email-channel-status.ts — is the email channel actually polling a mailbox? (#2409)
//
// Email adapters are built once at boot. The console's Enable gate reads accounts live, so
// an operator can add an account and enable the channel after boot: the gate passes, but
// nothing polls until the next start. setup-status must not call that "done".

import type { EmailChannelStatus } from '../../skills/types.js';

export interface EmailChannelStatusDeps {
  /** Email adapters started this boot (0 in setup-required mode, which skips them). */
  runningAdapterCount: () => number;
  /** The channel registry row's enabled flag, read now. */
  isEnabled: () => Promise<boolean>;
  /** The console's Enable gate, read now: API key + one enabled account with a grant. */
  gatePasses: () => Promise<boolean>;
}

export async function emailChannelStatus(deps: EmailChannelStatusDeps): Promise<EmailChannelStatus> {
  if (deps.runningAdapterCount() > 0) return 'running';
  if (!(await deps.isEnabled())) return 'not_configured';
  return (await deps.gatePasses()) ? 'restart_required' : 'not_configured';
}
