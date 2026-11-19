// setup-guide.ts — the setup guide panel's server side (#2358).
//
// While a new install is in Setup, web chat is the operator's, not the principal's: the
// dispatcher sends it to the setup agent instead of the coordinator, tells the agent which
// Setup step is open, and keeps those turns out of fact and relationship extraction.

/** The agent that answers web chat during Setup. */
export const SETUP_GUIDE_AGENT_ID = 'setup-wizard';

/**
 * Set by the chat route on a web inbound accepted while Setup runs: the dispatcher routes on
 * it, so a message accepted just before Start onboarding still reaches the setup guide.
 * Only the web channel's own route sets it, and the dispatcher reads it only on `web`.
 */
export const SETUP_GUIDE_METADATA_KEY = 'setupGuide';

// A catalog task id or one of the Setup page's own steps (apply, start): lower-case words.
const SETUP_STEP_RE = /^[a-z][a-z_]{0,39}$/;

/** The open Setup step a client sent, or null when absent or not step-shaped. */
export function readSetupStep(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const step = raw.trim();
  return SETUP_STEP_RE.test(step) ? step : null;
}

/** Sent when a setup guide turn names no step: the agent still learns it is on the Setup page. */
export const NO_SETUP_STEP = 'none';

/** The line that tells the setup guide it is on the Setup page, and which step is open. */
export function setupStepLine(step: string): string {
  if (step === NO_SETUP_STEP) return '[Setup page: the operator is setting Curia up; no particular step is open.]';
  return `[Setup page: the operator has the "${step}" step open. It matches a setup-status task id, or "apply" (Apply & restart) or "start" (Start onboarding).]`;
}
