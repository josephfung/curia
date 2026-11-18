// MailboxSignInDonePage.tsx — public result page after a Nylas hosted-auth mailbox sign-in (#2361).
//
// Reachable WITHOUT a session (child of rootRoute, like SecretCapturePage): the sign-in server
// routes redirect here with ?result=<outcome>&target=<principal|curia>&restart=<0|1>. The page
// reads only those three values, never a token or grant, and renders every one as plain text.
// The outcome list is the server's own (imported, so a new outcome cannot drift past this page).

import { useEffect, useState } from 'react';
import { CuriaWordmark } from '../components/Icons';
// Dependency-free server module, safe in the browser bundle.
import { MAILBOX_SIGNIN_OUTCOMES } from '../../../../src/nylas/signin-outcome.js';

/** Outcomes from the callback plus the results the start route redirects with. */
export const SIGNIN_RESULTS: readonly string[] = [
  ...MAILBOX_SIGNIN_OUTCOMES, 'not_found', 'used',
];

type Target = 'principal' | 'curia';
export interface ResultMessage { title: string; body: string; ok: boolean }

export function resultMessage(result: string, target: Target | null): ResultMessage {
  const whose = target === 'curia' ? "Curia's mailbox" : target === 'principal' ? 'Your mailbox' : 'The mailbox';
  switch (result) {
    case 'connected':
      return { ok: true, title: 'Connected', body: `${whose} is connected. You can close this window.` };
    case 'reconnected':
      return { ok: true, title: 'Reconnected', body: `${whose} was already set up and has been reconnected with a fresh sign-in. You can close this window.` };
    case 'expired':
      return { ok: false, title: 'Link expired', body: 'This sign-in link has expired. Ask Curia for a new one.' };
    case 'not_found':
      return { ok: false, title: 'Link not valid', body: 'This sign-in link is not valid. Ask Curia for a new one.' };
    case 'used':
      return { ok: false, title: 'Link already used', body: 'This sign-in link has already been used. If the mailbox is not connected, ask Curia for a new one.' };
    case 'cancelled':
      return { ok: false, title: 'Sign-in cancelled', body: 'You cancelled the Google sign-in, so nothing was connected. This sign-in link is now used. Ask Curia for a fresh sign-in link to retry.' };
    case 'admin_blocked':
      return { ok: false, title: 'Blocked by your Google admin', body: "Google Workspace blocked this sign-in. Please ask your Google Workspace admin to mark Curia's app as Trusted, then try again." };
    case 'org_internal':
      return { ok: false, title: 'Account not allowed', body: 'Curia\'s Google app is limited to one organization, and this account is outside it. Sign in with an account from that organization.' };
    case 'wrong_account':
      return { ok: false, title: 'Wrong account', body: 'You signed in with a different Google account than the one requested. This sign-in link is now used. Ask Curia for a fresh sign-in link, then choose the right account. If Google only offered accounts from one organization, the operator\'s Google app may be set to Internal; ask them to set its audience to External, then get a fresh link.' };
    case 'missing_scopes':
      return { ok: false, title: 'Permissions missing', body: 'Google did not grant everything Curia needs. When Google asks, leave both the mail and calendar boxes ticked, then try again.' };
    case 'not_google':
      return { ok: false, title: 'Not a Google account', body: 'Only Google accounts can be connected this way. Sign in with a Google account.' };
    case 'refused':
      return { ok: false, title: 'Not connected', body: 'Curia could not accept this mailbox. Check the address and the console settings, then try again.' };
    case 'failed':
      return { ok: false, title: 'Sign-in failed', body: 'Something went wrong while connecting the mailbox. Try again; if it keeps failing, ask for help.' };
    default:
      return { ok: false, title: 'Something went wrong', body: 'Something went wrong with the sign-in and Curia could not tell what happened. Ask Curia for a new link and try again.' };
  }
}

type RestartState = 'waiting' | 'back' | 'timeout';

const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 120_000;

export default function MailboxSignInDonePage(
  { pollIntervalMs = POLL_INTERVAL_MS, maxWaitMs = MAX_WAIT_MS }: { pollIntervalMs?: number; maxWaitMs?: number } = {},
) {
  const params = new URLSearchParams(window.location.search);
  const rawResult = params.get('result') ?? '';
  const result = SIGNIN_RESULTS.includes(rawResult) ? rawResult : 'unknown';
  const rawTarget = params.get('target');
  const target: Target | null = rawTarget === 'principal' || rawTarget === 'curia' ? rawTarget : null;
  const msg = resultMessage(result, target);
  const restart = params.get('restart') === '1' && msg.ok;

  const [restartState, setRestartState] = useState<RestartState>('waiting');

  useEffect(() => {
    if (!restart) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | null = null;
    // The deadline is its own timer, not a check between polls: a health request that never
    // answers (or stalls mid-body) must not keep the page on "restarting" past maxWaitMs.
    const deadline = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      if (timer) clearTimeout(timer);
      inFlight?.abort();
      setRestartState('timeout');
    }, maxWaitMs);
    // The old process may still answer for a moment after the restart is scheduled, so an ok
    // answer alone proves nothing. Done means: an ok answer after a failed/non-ok one (the old
    // process went away), or an ok answer whose uptime_s is below the first sample (a new
    // process). An ok answer with no usable uptime_s is not trusted on its own.
    let firstUptime: number | null = null;
    let sawFailure = false;
    const poll = async () => {
      const ctrl = new AbortController();
      inFlight = ctrl;
      try {
        const res = await fetch('/api/health', { signal: ctrl.signal });
        if (res.ok) {
          let uptime: number | null = null;
          try {
            const body = await res.json() as { uptime_s?: unknown };
            if (typeof body.uptime_s === 'number' && body.uptime_s >= 0) uptime = body.uptime_s;
          } catch {
            // A body that is not JSON carries no uptime: treated as not trustworthy below.
            // (An abort mid-body also lands here; the cancelled check below ends the poll.)
          }
          if (cancelled) return;
          const restarted = uptime !== null && firstUptime !== null && uptime < firstUptime;
          if (sawFailure || restarted) {
            cancelled = true;
            clearTimeout(deadline);
            setRestartState('back');
            return;
          }
          if (firstUptime === null && uptime !== null) firstUptime = uptime;
        } else {
          sawFailure = true;
        }
      } catch {
        // Expected while the process is down (and when the deadline or unmount aborts us).
        sawFailure = true;
      }
      if (cancelled) return;
      timer = setTimeout(() => void poll(), pollIntervalMs);
    };
    timer = setTimeout(() => void poll(), pollIntervalMs);
    return () => {
      cancelled = true;
      clearTimeout(deadline);
      if (timer) clearTimeout(timer);
      inFlight?.abort();
    };
  }, [restart, pollIntervalMs, maxWaitMs]);

  return (
    <div className="login-root">
      <div className="login-card">
        <div className="login-wordmark" aria-label="Curia"><CuriaWordmark /></div>
        <h2>{msg.title}</h2>
        <p className={msg.ok ? undefined : 'login-error'} role={msg.ok ? 'status' : 'alert'}>{msg.body}</p>
        {restart && (
          <p role="status">
            {restartState === 'waiting' && 'Curia is restarting to start using this mailbox. This takes a minute or so.'}
            {restartState === 'back' && 'Curia is back. Check Channels → Email to confirm the mailbox is running.'}
            {restartState === 'timeout' && 'Curia is taking longer than expected to restart. Please refresh this page in a minute.'}
          </p>
        )}
      </div>
    </div>
  );
}
