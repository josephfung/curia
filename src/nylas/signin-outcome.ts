// How a Nylas hosted-auth mailbox sign-in ended (#2361). The callback publishes one of these on
// mailbox_signin.finished; the same literals ride the console's `?signin=` query string, so
// MAILBOX_SIGNIN_OUTCOMES lets later code validate that string without a second copy of the list.

export const MAILBOX_SIGNIN_OUTCOMES = [
  'connected',
  'reconnected',
  'expired',
  'cancelled',
  'admin_blocked',
  'org_internal',
  'wrong_account',
  'missing_scopes',
  'not_google',
  'refused',
  // Nylas refused a new grant: the application's connected-account limit (5 on a sandbox).
  'account_limit',
  'failed',
] as const;

export type MailboxSignInOutcome = (typeof MAILBOX_SIGNIN_OUTCOMES)[number];
