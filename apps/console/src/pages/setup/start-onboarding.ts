// Starting onboarding from the console (#2360): the flow the last Setup step and the dashboard
// alert share. POST /api/onboarding/start, a confirmation when the install already looks in use,
// and, when Start restarts Curia to switch on Email triage, the same wait for a new
// GET /api/system bootedAt that Apply & restart uses.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../api.js';
import { errorMessage } from '../../components/settings/ConfigHistory.js';
import {
  evaluateRestartPoll,
  parseSystemPollResponse,
  RESTART_POLL_INTERVAL_MS,
  RESTART_TIMEOUT_MS,
  type RestartPollFetch,
} from '../system-utils.js';
import type { MessagingRoute, SetupFor } from './setup-api.js';

/** GET /api/onboarding/status. */
export interface OnboardingStatus {
  started: boolean;
  taskId: string | null;
  showDashboardAlert: boolean;
  workingPrincipalSignals: string[];
  route: MessagingRoute | null;
  setupFor: SetupFor | null;
  principalName: string | null;
  /** Email triage is held until the principal hears what to expect. */
  triageHeld: boolean;
}

export async function fetchOnboardingStatus(signal?: AbortSignal): Promise<OnboardingStatus> {
  const res = await apiFetch('/api/onboarding/status', signal ? { signal } : undefined);
  if (!res.ok) throw new Error(await errorMessage(res));
  return await res.json() as OnboardingStatus;
}

/** The server's current start time, read before anything that may restart it. */
export async function readBootedAt(signal?: AbortSignal): Promise<string> {
  const res = await apiFetch('/api/system', signal ? { signal } : undefined);
  if (!res.ok) throw new Error(await errorMessage(res));
  const parsed = parseSystemPollResponse(res.status, await res.json() as unknown);
  if (parsed.kind !== 'ok') throw new Error('Could not read the server’s start time.');
  return parsed.snapshot.bootedAt;
}

export const RESTART_SLOW = 'Curia hasn’t come back yet. Check that its container restarted, then reload this page.';

/**
 * Polls GET /api/system until bootedAt differs from `previousBootedAt`, as Apply & restart does:
 * errors while the server is down are expected and keep the poll going until the ceiling.
 * True when Curia is back; false on the ceiling or an abort.
 */
export async function waitForRestart(previousBootedAt: string, signal: AbortSignal): Promise<boolean> {
  const startedAtMs = Date.now();
  while (!signal.aborted) {
    let fetched: RestartPollFetch;
    try {
      const res = await apiFetch('/api/system', { signal });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Expected mid-restart: a proxy error page is not JSON. parseSystemPollResponse reads a
        // null body as malformed, and the poll goes on.
        body = null;
      }
      fetched = parseSystemPollResponse(res.status, body);
    } catch {
      // Expected mid-restart: the server is down (or the wait was aborted). Logging every refused
      // poll would flood the console; the deadline reports a restart that never lands.
      fetched = { kind: 'transport_error' };
    }
    if (signal.aborted) return false;
    const decision = evaluateRestartPoll({ previousBootedAt, startedAtMs, nowMs: Date.now(), timeoutMs: RESTART_TIMEOUT_MS, fetch: fetched });
    if (decision.kind === 'succeeded') return true;
    if (decision.kind === 'timeout') return false;
    await new Promise<void>((resolve) => {
      const onAbort = (): void => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, RESTART_POLL_INTERVAL_MS);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  return false;
}

/** The phone app invitation Start minted (app route only). */
export interface StartedInvitation {
  url: string;
  expiresAt: string;
}

export type StartFlow =
  | { kind: 'idle' }
  | { kind: 'working' }
  /** The install already looks in use: ask before starting. */
  | { kind: 'confirm'; signals: string[] }
  | {
      kind: 'started';
      invitation: StartedInvitation | null;
      /**
       * Start restarts Curia to switch on Email triage: waiting, back, or not back in time.
       * `unknown`: its start time couldn't be read beforehand, so its return can't be told.
       */
      restart: 'none' | 'waiting' | 'back' | 'slow' | 'unknown';
    }
  /** Another start got there first. */
  | { kind: 'already_started' }
  /** `unreachable`: Curia can't reach the principal on this Setup route (the page links the fix). */
  | { kind: 'failed'; message: string; unreachable?: MessagingRoute | null };

/** What a working-principal signal means, for the confirmation. */
export function signalText(signal: string, principal: string): string {
  if (signal === 'email_triage_enabled') return 'Email triage is already on.';
  if (signal === 'prior_principal_tasks') return `${principal} already has tasks or conversations with Curia.`;
  return signal;
}

/** The confirmation before "Not right now" (design §3), by who Curia is set up for. */
export function notRightNowText(setupFor: SetupFor | null, principal: string): string {
  if (setupFor === 'self') {
    return 'Onboarding is where Curia learns how you like to work. It’s required before Curia acts for you. You can start it any time from the dashboard.';
  }
  return `Onboarding is ${principal}’s first conversation with Curia. It’s required before Curia acts for them. Start it from the dashboard when they’re ready. Curia won’t contact them until you do.`;
}

/** The message to send with the invitation link; it says the link lasts 48 hours. */
export function invitationMessage(url: string, setupFor: SetupFor | null, principal: string): string {
  if (setupFor === 'self') {
    return `Open this link on your phone, in Safari or Chrome, to install Curia and sign in. It works once and is valid for 48 hours: ${url}`;
  }
  return `Hi ${principal}, this link installs Curia on your phone and signs you in. Open it in Safari or Chrome. It works once and is valid for 48 hours: ${url}`;
}

export const ROUTE_LABEL: Record<Exclude<MessagingRoute, 'app'>, string> = { signal: 'Signal', sms: 'SMS', slack: 'Slack' };

/**
 * Why Start was refused with route_unreachable, as one line. Setup is over by then, so it points
 * at places that still exist (Channels, the principal's contact), never the Setup page; the page
 * turns the Channels and contact words into links on Signal, SMS and Slack.
 */
export function unreachableText(route: MessagingRoute | null, principal: string): string {
  if (route === 'app') {
    return 'Curia can’t make the phone app invitation yet: its address (APP_ORIGIN) isn’t set. Set it, restart Curia, then start onboarding again.';
  }
  if (route === null) return `Curia doesn’t know how to reach ${principal}: no messaging route was chosen in Setup.`;
  const label = ROUTE_LABEL[route];
  return `Curia can’t reach ${principal} on ${label} yet. Check that the ${label} channel is on in Channels and that ${principal}’s ${label} details are on their contact.`;
}

/** What Curia did on a messaging route other than the app. */
export function helloText(route: MessagingRoute | null): string | null {
  return route && route !== 'app' ? `Curia has said hello on ${ROUTE_LABEL[route]}.` : null;
}

type StartBody =
  | { ok: true; taskId: string; invitation: StartedInvitation | null; restartScheduled: boolean }
  | { ok: false; code: string; signals?: string[] };

/**
 * The start flow. `onSetupIncomplete` re-reads whatever shows Setup's missing steps (the
 * checklist on the Setup page); `onAlreadyStarted` refreshes whatever shows the status.
 */
export function useStartOnboarding(opts: {
  principal: string;
  /** The messaging route from Setup, for the route_unreachable advice. */
  route: MessagingRoute | null;
  onSetupIncomplete?: () => Promise<void>;
  onAlreadyStarted?: () => Promise<void>;
}): { flow: StartFlow; start: (confirmWorkingPrincipal: boolean) => Promise<void>; cancel: () => void } {
  const [flow, setFlow] = useState<StartFlow>({ kind: 'idle' });
  const posting = useRef(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const { principal, route, onSetupIncomplete, onAlreadyStarted } = opts;

  const start = useCallback(async (confirmWorkingPrincipal: boolean): Promise<void> => {
    if (posting.current) return;
    posting.current = true;
    setFlow({ kind: 'working' });
    try {
      // Read before starting: Start may restart Curia, and only a new bootedAt says it's back.
      // A failed read doesn't block Start; a restart then can't be watched (restart: 'unknown').
      let previousBootedAt: string | null = null;
      try {
        previousBootedAt = await readBootedAt();
      } catch (err) {
        console.error('[onboarding] could not read the server’s start time before Start:', err);
      }
      const res = await apiFetch('/api/onboarding/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmWorkingPrincipal }),
      });
      if (res.status !== 200 && res.status !== 409) throw new Error(await errorMessage(res));
      const body = await res.json() as StartBody;
      if (!body.ok) {
        if (body.code === 'confirm_working_principal') {
          setFlow({ kind: 'confirm', signals: body.signals ?? [] });
        } else if (body.code === 'already_started') {
          setFlow({ kind: 'already_started' });
          await onAlreadyStarted?.();
        } else if (body.code === 'route_unreachable') {
          setFlow({ kind: 'failed', message: unreachableText(route, principal), unreachable: route });
        } else if (body.code === 'setup_incomplete') {
          setFlow({ kind: 'failed', message: 'Setup isn’t finished: something stopped passing. The Setup steps show what’s left.' });
          await onSetupIncomplete?.();
        } else {
          throw new Error(`Could not start onboarding (${body.code}).`);
        }
        return;
      }
      const restart = !body.restartScheduled ? 'none' : previousBootedAt === null ? 'unknown' : 'waiting';
      setFlow({ kind: 'started', invitation: body.invitation, restart });
      if (restart === 'waiting' && previousBootedAt !== null) {
        const controller = new AbortController();
        abort.current = controller;
        const back = await waitForRestart(previousBootedAt, controller.signal);
        if (controller.signal.aborted) return;
        setFlow((f) => (f.kind === 'started' ? { ...f, restart: back ? 'back' : 'slow' } : f));
      }
    } catch (err) {
      setFlow({ kind: 'failed', message: err instanceof Error ? err.message : 'Could not start onboarding.' });
    } finally {
      posting.current = false;
    }
  }, [principal, route, onSetupIncomplete, onAlreadyStarted]);

  const cancel = useCallback(() => setFlow({ kind: 'idle' }), []);
  return { flow, start, cancel };
}
