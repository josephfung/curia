// GoogleWorkspaceSignInDonePage.tsx — public result page after "Sign in as Curia" (#2683).
//
// Reachable WITHOUT a session (child of rootRoute, like MailboxSignInDonePage): the callback
// redirects here with ?result=<outcome>&restart=<0|1> and nothing else. The outcome list is the
// server's own (imported), so a new outcome cannot drift past this page. While Curia restarts
// to pick up the sign-in, the page waits for it the same way the mailbox page does.
import { CuriaWordmark } from '../components/Icons';
// Dependency-free server module, safe in the browser bundle.
import { WORKSPACE_SIGNIN_OUTCOMES } from '../../../../src/google/workspace-signin-outcome.js';
import { useRestartWait } from './MailboxSignInDonePage';

export interface ResultMessage { title: string; body: string; ok: boolean }

const AGAIN = 'Go back to the Google Workspace step and choose Sign in as Curia again.';

export function workspaceResultMessage(result: string): ResultMessage {
  switch (result) {
    case 'signed_in':
      return { ok: true, title: 'Signed in', body: 'Curia is signed in to Google Workspace and can now work in Docs, Sheets and Drive.' };
    case 'expired':
      return { ok: false, title: 'Sign-in timed out', body: `This sign-in took too long, so nothing was saved. ${AGAIN}` };
    case 'used':
      return { ok: false, title: 'Already used', body: `This sign-in was already completed or refused. If the step does not show Signed in, ${AGAIN.charAt(0).toLowerCase()}${AGAIN.slice(1)}` };
    case 'not_found':
      return { ok: false, title: 'Not a valid sign-in', body: `Curia did not start this sign-in. ${AGAIN}` };
    case 'cancelled':
      return { ok: false, title: 'Sign-in cancelled', body: `You cancelled on Google’s screen, so nothing was saved. ${AGAIN}` };
    case 'wrong_account':
      return { ok: false, title: 'Wrong Google account', body: `That was not Curia’s Google address, so nothing was saved. Sign in with the address saved in the Google Workspace step (Curia’s own account, not yours). ${AGAIN}` };
    case 'missing_scopes':
      return { ok: false, title: 'Permissions missing', body: `Google did not grant everything Curia needs, so nothing was saved. When Google asks, leave the Drive, Docs and Sheets boxes ticked. ${AGAIN}` };
    case 'not_ready':
      return { ok: false, title: 'Settings missing', body: 'Curia’s Google address, the OAuth client ID or the secret is missing, or APP_ORIGIN is not set. Check the Google Workspace step, then sign in again.' };
    case 'failed':
      return { ok: false, title: 'Sign-in failed', body: `Something went wrong while saving the sign-in. Check that this page’s address is in the OAuth client’s authorized redirect URIs. ${AGAIN}` };
    default:
      return { ok: false, title: 'Something went wrong', body: `Curia could not tell how the sign-in ended. ${AGAIN}` };
  }
}

export default function GoogleWorkspaceSignInDonePage(
  { pollIntervalMs, maxWaitMs }: { pollIntervalMs?: number; maxWaitMs?: number } = {},
) {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('result') ?? '';
  const result = (WORKSPACE_SIGNIN_OUTCOMES as readonly string[]).includes(raw) ? raw : 'unknown';
  const msg = workspaceResultMessage(result);
  const restart = params.get('restart') === '1' && msg.ok;
  const restartState = useRestartWait(restart, { pollIntervalMs, maxWaitMs });

  return (
    <div className="login-root">
      <div className="login-card">
        <div className="login-wordmark" aria-label="Curia"><CuriaWordmark /></div>
        <h2>{msg.title}</h2>
        <p className={msg.ok ? undefined : 'login-error'} role={msg.ok ? 'status' : 'alert'}>{msg.body}</p>
        {restart && (
          <p role="status">
            {restartState === 'waiting' && 'Curia is restarting to start using it. This takes a minute or so.'}
            {restartState === 'back' && 'Curia is back.'}
            {restartState === 'timeout' && 'Curia is taking longer than expected to restart. Please refresh this page in a minute.'}
          </p>
        )}
        {(!restart || restartState !== 'waiting') && (
          <p><a href="/setup?step=google_workspace">Back to Curia</a></p>
        )}
      </div>
    </div>
  );
}
