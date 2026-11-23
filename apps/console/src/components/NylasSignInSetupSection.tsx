import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { apiFetch } from '../api.js';
import { SIGNIN_READINESS_EVENT } from './ConnectWithGoogle.js';

// ── Nylas sign-in setup (#2361) ──────────────────────────────────────────────
//
// Top of Settings → Behaviour → Email & Calendar. Sets up Nylas hosted sign-in from the
// Nylas API key already saved under Channels → Email, as three steps with their own status:
// the region, the sign-in callback URL, and the Google connector. Reads readiness live from
// GET /api/registry/nylas/signin. On the first load the panel does the two steps it can do on
// its own (detect an unknown region, register an unregistered callback) once each; their
// buttons appear only if that failed. A sandbox application has Nylas's own Google connector,
// so the connector form is shown only for a production application without one. The GCP client
// secret lives only in this component's state while the form is open: it is cleared on a
// successful create, and the server never stores or returns it.

type Region = 'us' | 'eu';
type Reason =
  | 'no_api_key' | 'restart_required' | 'bad_api_key' | 'origin_not_https'
  | 'callback_unregistered' | 'no_google_connector' | 'nylas_unreachable' | 'settings_unreadable';
type Step = 'region' | 'callback' | 'connector';

interface SignInStatus {
  ready?: boolean;
  /** A Reason, or one this console does not know yet (then `detail` is shown). */
  reason?: string;
  detail?: string;
  region?: Region;
  callbackUrl?: string | null;
  googleRedirectUri?: string;
  environment?: 'sandbox' | 'production';
  /** Each set once the check got that far. */
  checks?: { callbackRegistered?: boolean; googleConnector?: boolean };
}

const BASE = '/api/registry/nylas';

const REGION_HOST: Record<Region, string> = { us: 'api.us.nylas.com', eu: 'api.eu.nylas.com' };

function isReason(r: string | undefined): r is Reason {
  return r !== undefined && Object.prototype.hasOwnProperty.call(FIX, r);
}

// One line per failing reason: what to do next. The two step reasons point at their step,
// which shows the control.
const FIX: Record<Reason, string> = {
  no_api_key: 'Save the Nylas API key under Channels → Email first.',
  restart_required: 'Restart Curia to finish setting up sign-in.',
  bad_api_key: 'Nylas rejected the API key. Check the key under Channels → Email, then detect its region.',
  origin_not_https: 'Set APP_ORIGIN to this console\'s public https:// address and restart Curia.',
  callback_unregistered: 'Register the sign-in callback with Nylas (step 2).',
  no_google_connector: 'Create the Google connector (step 3).',
  nylas_unreachable: 'Nylas did not answer. Check again in a moment.',
  settings_unreadable: 'Curia could not read its saved Nylas settings. Check again in a moment; if it persists, check the server logs.',
};

// Reasons that stop the check before Nylas is asked anything: no step is acted on by itself.
const BLOCKING: ReadonlySet<string> = new Set(['no_api_key', 'restart_required', 'settings_unreadable']);

async function errorMessage(res: Response): Promise<string> {
  try {
    const d = await res.json() as { error?: string };
    if (d.error) return d.error;
  } catch (err) {
    console.error('[NylasSignInSetupSection errorMessage] failed to parse the error body:', err);
  }
  return `HTTP ${res.status}`;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** One numbered step: a ✓ once done, else its number; what to do goes in the body. */
function SetupStep({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <div className="settings-kv-row">
      <dt>
        <span className={done ? 'nylas-step-mark done' : 'nylas-step-mark'} aria-hidden="true">{done ? '✓' : n}</span>
        {title}
        <span className="sr-only">{done ? ' (done)' : ' (to do)'}</span>
      </dt>
      <dd className="nylas-step-body">{children}</dd>
    </div>
  );
}

/** The outcome of the last action on a step, shown inside that step. */
function StepMessage({ msg }: { msg: { notice?: string; error?: string } | undefined }) {
  if (!msg) return null;
  if (msg.error) return <p className="autonomy-error" role="alert">{msg.error}</p>;
  if (msg.notice) return <p className="nylas-step-note" role="status">{msg.notice}</p>;
  return null;
}

/**
 * keyLocation: where the API key is entered, for the two lines that send the operator
 * there. Settings says "under Channels → Email"; the Setup page says "in the Email step".
 */
export function NylasSignInSetupSection({ keyLocation = 'under Channels → Email' }: { keyLocation?: string } = {}) {
  const [status, setStatus] = useState<SignInStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // True while any action or the first-load chain's steps run (see hold()).
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<Step | null>(null);
  const [messages, setMessages] = useState<Partial<Record<Step, { notice?: string; error?: string }>>>({});
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [topic, setTopic] = useState('');

  // Only the newest check may apply its result: a slow earlier one must not overwrite it.
  const checkSeq = useRef(0);
  const mounted = useRef(false);
  // Work in flight: the first-load chain and each action hold one count. The panel is busy while
  // any is held, and each holder releases only its own count, so one finishing never frees
  // another's lock.
  const pending = useRef(0);
  const hold = useCallback(() => {
    pending.current++;
    setBusy(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pending.current--;
      if (mounted.current) setBusy(pending.current > 0);
    };
  }, []);

  // Resolves to the status it applied, or null when it failed or a newer check superseded it.
  const check = useCallback(async (): Promise<SignInStatus | null> => {
    const seq = ++checkSeq.current;
    try {
      const res = await apiFetch(`${BASE}/signin`);
      if (!res.ok) throw new Error(await errorMessage(res));
      const next = await res.json() as SignInStatus;
      if (seq !== checkSeq.current || !mounted.current) return null;
      setStatus(next);
      setLoadError(null);
      // Tell the Connect with Google buttons on this page (they read readiness only on mount).
      window.dispatchEvent(new CustomEvent(SIGNIN_READINESS_EVENT, {
        detail: { ready: next.ready === true, detail: next.detail },
      }));
      return next;
    } catch (err) {
      if (seq !== checkSeq.current || !mounted.current) return null;
      console.error('[NylasSignInSetupSection] failed to read sign-in readiness:', err);
      // A stale Ready (or an old reason) must not sit beside the error.
      setStatus(null);
      setLoadError(err instanceof Error ? err.message : 'unknown error');
      return null;
    }
  }, []);

  // Bumps the live counter when called, so every check still in flight fails its guard.
  const invalidateChecks = useCallback(() => { checkSeq.current++; }, []);

  // Run one action for a step, then re-check. Resolves to the re-checked status (or null) on
  // success, undefined on failure. The outcome is shown inside that step.
  // A manual action (auto false) never starts while other work is in flight; the first-load
  // chain's own steps pass auto true, since the chain already holds the lock they run under.
  const act = useCallback(async (
    step: Step, run: () => Promise<Response>, done: string, auto = false,
  ): Promise<SignInStatus | null | undefined> => {
    if (!auto && pending.current > 0) return undefined;
    const release = hold();
    setWorking(step);
    setMessages({});
    try {
      const res = await run();
      if (!res.ok) throw new Error(await errorMessage(res));
      if (!mounted.current) return undefined; // left the page: no re-check, no broadcast
      setMessages({ [step]: { notice: done } });
      return await check();
    } catch (err) {
      console.error(`[NylasSignInSetupSection] ${step} action failed:`, err);
      if (mounted.current) setMessages({ [step]: { error: err instanceof Error ? err.message : 'unknown error' } });
      return undefined;
    } finally {
      release();
      if (mounted.current) setWorking((w) => (w === step ? null : w));
    }
  }, [check, hold]);

  useEffect(() => {
    mounted.current = true;
    // First load: do the steps Curia can do by itself, once each, in order.
    let release = (): void => {};
    void (async () => {
      let s = await check();
      if (!mounted.current || s === null || s.ready === true) return;
      // A manual action started while the first check loaded: it re-checks when it ends, so the
      // chain steps aside rather than run alongside it.
      if (pending.current > 0) return;
      release = hold();
      const regionUnknown = (s.region === undefined && !BLOCKING.has(s.reason ?? '')) || s.reason === 'bad_api_key';
      if (regionUnknown) {
        const after = await act('region', () => apiFetch(`${BASE}/discover-region`, jsonInit('POST', {})), 'Region detected and saved.', true);
        if (!mounted.current || !after) return;
        s = after;
      }
      if (s.checks?.callbackRegistered === false && s.callbackUrl) {
        await act('callback', () => apiFetch(`${BASE}/callback`, jsonInit('POST', {})), 'Callback registered with Nylas.', true);
      }
    })().finally(() => release());
    // Unmount invalidates any check still in flight: a late answer must neither set state nor
    // broadcast a stale result to a page mounted afterwards.
    return () => { mounted.current = false; invalidateChecks(); };
  }, [check, act, hold, invalidateChecks]);

  const ready = status?.ready === true;
  const region: Region | undefined = status?.region;
  const regionDone = region !== undefined && status?.reason !== 'bad_api_key';
  const callbackUrl = status?.callbackUrl ?? null;
  const callbackRegistered = ready || status?.checks?.callbackRegistered === true;
  const sandbox = status?.environment === 'sandbox';
  const connectorDone = ready || sandbox || status?.checks?.googleConnector === true;
  const connectorMissing = !sandbox && status?.checks?.googleConnector === false;
  const canCreate = clientId.trim() !== '' && clientSecret.trim() !== '' && !busy;

  function saveRegion(next: string) {
    if (next !== 'us' && next !== 'eu') return;
    void act('region', () => apiFetch(`${BASE}/region`, jsonInit('PUT', { region: next })), 'Region saved.');
  }

  // The inputs are locked while the create request and re-check run, so the success cleanup
  // below can only clear the draft that was submitted.
  async function createConnector() {
    const body: Record<string, string> = { client_id: clientId.trim(), client_secret: clientSecret.trim() };
    if (topic.trim() !== '') body['topic_name'] = topic.trim();
    const res = await act('connector', () => apiFetch(`${BASE}/google-connector`, jsonInit('POST', body)), 'Google connector created.');
    // Clear the secret once Nylas has it, whether or not the re-check then reads ready.
    if (res !== undefined) { setClientId(''); setClientSecret(''); setTopic(''); }
  }

  const checkAgain = (
    <button type="button" className="link-button" disabled={busy} onClick={() => { setMessages({}); void check(); }}>
      Check again
    </button>
  );

  let summary: ReactNode;
  if (loadError) {
    summary = (
      <div className="settings-callout settings-callout-danger" role="alert">
        <p>Couldn&apos;t check sign-in: {loadError}. {checkAgain}</p>
      </div>
    );
  } else if (status === null) {
    summary = <p className="settings-muted-hint" role="status">Checking Nylas… {checkAgain}</p>;
  } else if (ready) {
    summary = (
      <div className="settings-callout settings-callout-success" role="status">
        <p><strong>Ready.</strong> Mailboxes can be added by signing in with Google. {checkAgain}</p>
      </div>
    );
  } else {
    const why = isReason(status.reason)
      ? FIX[status.reason].replace('under Channels → Email', keyLocation)
      : (status.detail || 'Sign-in is not set up yet.');
    summary = (
      <div className="settings-callout settings-callout-readonly" role="status">
        <p><strong>Not ready.</strong> {why} {checkAgain}</p>
      </div>
    );
  }

  const notChecked = <p className="nylas-step-note">Not checked yet.</p>;

  return (
    <section className="settings-section" aria-label="Nylas sign-in setup">
      <div className="settings-section-head">
        <h3 className="settings-section-title">Nylas</h3>
        <p className="settings-section-sub">
          Connects Curia to Gmail through Nylas, so mailboxes are added by signing in with Google.
        </p>
      </div>
      <div className="settings-section-body">
        {summary}

        <dl className="settings-kv-list">
          <SetupStep n={1} title="Region" done={regionDone}>
            {regionDone && region ? (
              <div className="nylas-step-inline">
                <span>{region.toUpperCase()} <code>{REGION_HOST[region]}</code></span>
                <select aria-label="Change Nylas region" value="" disabled={busy}
                  onChange={e => saveRegion(e.target.value)}>
                  <option value="" disabled>Change…</option>
                  <option value="us">US (api.us.nylas.com)</option>
                  <option value="eu">EU (api.eu.nylas.com)</option>
                </select>
              </div>
            ) : (
              <>
                <p className="nylas-step-note">Choose the region of your Nylas application, or detect it from the API key.</p>
                <div className="nylas-step-inline">
                  <select aria-label="Nylas region" value={region ?? ''} disabled={busy}
                    onChange={e => saveRegion(e.target.value)}>
                    {region === undefined && <option value="" disabled>Choose…</option>}
                    <option value="us">US (api.us.nylas.com)</option>
                    <option value="eu">EU (api.eu.nylas.com)</option>
                  </select>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                    onClick={() => void act('region', () => apiFetch(`${BASE}/discover-region`, jsonInit('POST', {})), 'Region detected and saved.')}>
                    Detect
                  </button>
                </div>
              </>
            )}
            {working === 'region' && <p className="nylas-step-note" role="status">Asking Nylas…</p>}
            <StepMessage msg={messages.region} />
          </SetupStep>

          <SetupStep n={2} title="Callback" done={callbackRegistered}>
            {callbackUrl ? (
              <>
                <code className="nylas-step-code">{callbackUrl}</code>
                {callbackRegistered && <p className="nylas-step-note">Registered with Nylas.</p>}
                {!callbackRegistered && status?.checks?.callbackRegistered === undefined && notChecked}
                {status?.checks?.callbackRegistered === false && working !== 'callback' && (
                  <div className="nylas-step-inline">
                    <span className="nylas-step-note">Not registered with Nylas yet.</span>
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                      onClick={() => void act('callback', () => apiFetch(`${BASE}/callback`, jsonInit('POST', {})), 'Callback registered with Nylas.')}>
                      Register callback
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="nylas-step-note">Set APP_ORIGIN to this console&apos;s public https:// address to get the callback URL.</p>
            )}
            {working === 'callback' && <p className="nylas-step-note" role="status">Registering with Nylas…</p>}
            <StepMessage msg={messages.callback} />
          </SetupStep>

          <SetupStep n={3} title="Google connector" done={connectorDone}>
            {sandbox ? (
              <>
                <p>Built in (Nylas sandbox)</p>
                <p className="nylas-step-note">
                  Sandbox application: uses Nylas&apos;s built-in Google connector and allows up to 5
                  connected accounts. Use a production application for more, or to use your own Google app.
                </p>
              </>
            ) : connectorDone ? (
              <p>Google connector set up.</p>
            ) : connectorMissing ? (
              <div className="nylas-connector-form">
                <p className="nylas-step-note">
                  Create it from your Google Cloud OAuth client. Curia passes the secret to Nylas and
                  does not keep it.
                </p>
                {status?.googleRedirectUri && (
                  <div className="form-field">
                    <span className="nylas-step-label">Authorised redirect URI for your Google OAuth client</span>
                    <code className="nylas-step-code">{status.googleRedirectUri}</code>
                  </div>
                )}
                <div className="form-field">
                  <label htmlFor="nylas-google-client-id">Client ID</label>
                  <input id="nylas-google-client-id" type="text" disabled={busy} value={clientId}
                    onChange={e => setClientId(e.target.value)} autoComplete="off" />
                </div>
                <div className="form-field">
                  <label htmlFor="nylas-google-client-secret">Client secret</label>
                  <input id="nylas-google-client-secret" type="password" disabled={busy} value={clientSecret}
                    onChange={e => setClientSecret(e.target.value)} autoComplete="off" />
                </div>
                <div className="form-field">
                  <label htmlFor="nylas-google-topic">Pub/Sub topic (optional)</label>
                  <input id="nylas-google-topic" type="text" disabled={busy} value={topic}
                    onChange={e => setTopic(e.target.value)} autoComplete="off" />
                </div>
                <div className="nylas-step-inline">
                  <button type="button" className="btn btn-primary" disabled={!canCreate} onClick={() => void createConnector()}>
                    Create connector
                  </button>
                </div>
              </div>
            ) : notChecked}
            {working === 'connector' && <p className="nylas-step-note" role="status">Creating the connector…</p>}
            <StepMessage msg={messages.connector} />
          </SetupStep>
        </dl>
      </div>
    </section>
  );
}
