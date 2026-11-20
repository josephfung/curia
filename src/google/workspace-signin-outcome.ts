// How a "Sign in as Curia" Google Workspace sign-in ended (#2683). The callback redirects to the
// console's done page with one of these as `?result=`, and the page imports this list to
// validate it, so the two cannot drift. Dependency-free: it is bundled into the browser.

export const WORKSPACE_SIGNIN_OUTCOMES = [
  'signed_in',
  // The state token: lapsed, already spent, or never minted.
  'expired',
  'used',
  'not_found',
  // The operator backed out on Google's consent screen.
  'cancelled',
  // Signed in as an account other than Curia's saved Google address.
  'wrong_account',
  // Google did not grant every scope Curia needs (an unticked box on the consent screen).
  'missing_scopes',
  // The address, client ID or secret is missing, or APP_ORIGIN is unusable.
  'not_ready',
  'failed',
] as const;

export type WorkspaceSignInOutcome = (typeof WORKSPACE_SIGNIN_OUTCOMES)[number];
