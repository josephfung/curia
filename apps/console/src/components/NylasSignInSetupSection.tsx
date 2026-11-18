import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../api.js';

// ── Nylas sign-in setup (#2361) ──────────────────────────────────────────────
//
// Top of Settings → Behaviour → Email & Calendar. Sets up Nylas hosted sign-in from the
// Nylas API key already saved under Channels → Email: pick or detect the region, register the
// callback URL, and create the Google connector from a GCP OAuth client. Reads readiness live
// from GET /api/registry/nylas/signin. The GCP client secret lives only in this component's
// state while the form is open: it is cleared on a successful create, and the server never
// stores or returns it.

type Region = 'us' | 'eu';
type Reason =
  | 'no_api_key' | 'bad_api_key' | 'sandbox' | 'origin_not_https'
  | 'callback_unregistered' | 'no_google_connector' | 'nylas_unreachable';

interface SignInStatus {
  ready?: boolean;
  reason?: Reason;
  detail?: string;
  region?: Region;
  callbackUrl?: string | null;
  googleRedirectUri?: string;
}

const BASE = '/api/registry/nylas';

// One line per failing reason: what to do next.
const FIX: Record<Reason, string> = {
  no_api_key: 'Save the Nylas API key under Channels → Email first.',
  bad_api_key: 'Nylas rejected the key. Check the key, then use Detect to find its region.',
  sandbox: 'This Nylas application is a sandbox. Use a production application and its API key.',
  origin_not_https: 'Set APP_ORIGIN to this console\'s public https:// address and restart Curia.',
  callback_unregistered: 'Click Register callback to add the sign-in callback URL to Nylas.',
  no_google_connector: 'Create the Google connector below with your Google Cloud OAuth client.',
  nylas_unreachable: 'Nylas did not answer. Try Check again in a moment.',
};

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

export function NylasSignInSetupSection() {
  const [status, setStatus] = useState<SignInStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [topic, setTopic] = useState('');

  const check = useCallback(async () => {
    try {
      const res = await apiFetch(`${BASE}/signin`);
      if (!res.ok) throw new Error(await errorMessage(res));
      setStatus(await res.json() as SignInStatus);
      setLoadError(null);
    } catch (err) {
      console.error('[NylasSignInSetupSection] failed to read sign-in readiness:', err);
      setLoadError(err instanceof Error ? err.message : 'unknown error');
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  // Run one action, then re-check. Returns whether it succeeded.
  async function act(run: () => Promise<Response>, done: string): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await run();
      if (!res.ok) throw new Error(await errorMessage(res));
      setNotice(done);
      await check();
      return true;
    } catch (err) {
      console.error('[NylasSignInSetupSection] action failed:', err);
      setActionError(err instanceof Error ? err.message : 'unknown error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const region: Region = status?.region ?? 'us';
  const googleRedirect = status?.googleRedirectUri ?? `https://api.${region}.nylas.com/v3/connect/callback`;
  const canCreate = clientId.trim() !== '' && clientSecret.trim() !== '' && !busy;

  async function createConnector() {
    const body: Record<string, string> = { client_id: clientId.trim(), client_secret: clientSecret.trim() };
    if (topic.trim() !== '') body['topic_name'] = topic.trim();
    const ok = await act(() => apiFetch(`${BASE}/google-connector`, jsonInit('POST', body)), 'Google connector created.');
    // Clear the secret once Nylas has it, whether or not the re-check then reads ready.
    if (ok) { setClientId(''); setClientSecret(''); setTopic(''); }
  }

  return (
    <section className="settings-section" aria-label="Nylas sign-in setup">
      <h3 className="settings-section-title">Sign in with Google (Nylas)</h3>
      <div className="settings-section-body">
        <p className="settings-page-sub">
          Lets you add Gmail mailboxes by signing in with Google instead of copying grant IDs.
          Uses the Nylas API key saved under Channels → Email.
        </p>

        {loadError && <p className="autonomy-error" role="alert">Couldn&apos;t check sign-in: {loadError}</p>}
        {status && status.ready === true && (
          <p role="status"><strong>Ready.</strong> Mailbox sign-in is set up.</p>
        )}
        {status && status.ready === false && status.reason && (
          <p className="autonomy-error" role="alert">
            Not ready: {FIX[status.reason]}
          </p>
        )}

        <div className="form-field">
          <label>
            Region{' '}
            <select
              aria-label="Nylas region"
              value={region}
              disabled={busy}
              onChange={e => { const next = e.target.value; void act(() => apiFetch(`${BASE}/region`, jsonInit('PUT', { region: next })), 'Region saved.'); }}
            >
              <option value="us">US (api.us.nylas.com)</option>
              <option value="eu">EU (api.eu.nylas.com)</option>
            </select>
          </label>
          {' '}
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
            onClick={() => void act(() => apiFetch(`${BASE}/discover-region`, jsonInit('POST', {})), 'Region detected and saved.')}>
            Detect
          </button>
          {' '}
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void check()}>
            Check
          </button>
        </div>

        <div className="form-field">
          <div>Sign-in callback URL (registered with Nylas):</div>
          <code>{status?.callbackUrl ?? 'Set APP_ORIGIN to see it'}</code>
          {' '}
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !status?.callbackUrl}
            onClick={() => void act(() => apiFetch(`${BASE}/callback`, jsonInit('POST', {})), 'Callback registered.')}>
            Register callback
          </button>
        </div>

        <div className="form-field">
          <div>Google Cloud: add this as an authorised redirect URI on your OAuth client:</div>
          <code>{googleRedirect}</code>
        </div>

        <div className="form-field">
          <div>Create the Google connector from your Google Cloud OAuth client:</div>
          <label style={{ display: 'block', marginBottom: 6 }}>
            Client ID{' '}
            <input aria-label="Google client ID" value={clientId} onChange={e => setClientId(e.target.value)} autoComplete="off" />
          </label>
          <label style={{ display: 'block', marginBottom: 6 }}>
            Client secret{' '}
            <input aria-label="Google client secret" type="password" value={clientSecret}
              onChange={e => setClientSecret(e.target.value)} autoComplete="off" />
          </label>
          <label style={{ display: 'block', marginBottom: 6 }}>
            Pub/Sub topic (optional){' '}
            <input aria-label="Pub/Sub topic" value={topic} onChange={e => setTopic(e.target.value)} autoComplete="off" />
          </label>
          <button type="button" className="btn btn-primary btn-sm" disabled={!canCreate} onClick={() => void createConnector()}>
            Create connector
          </button>
          <p className="settings-page-sub">Curia passes the secret to Nylas and does not keep it.</p>
        </div>

        {notice && <p role="status">{notice}</p>}
        {actionError && <p className="autonomy-error" role="alert">{actionError}</p>}
      </div>
    </section>
  );
}
