import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../api.js';

// Mirrors the Task 9 email-accounts registry entry shape.
interface EmailAccount {
  name: string;
  selfEmail: string;
  provider: string;
  enabled: boolean;
  hasGrant: boolean;
}

// Safe error message extraction — matches the pattern in ChannelSettings.tsx.
// Guards against non-JSON error bodies and logs parse failures rather than swallowing.
async function errorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string };
      if (d.error) return d.error;
    } catch (err) {
      console.error('[EmailAccountsSection errorMessage] failed to parse JSON error body:', err);
    }
  }
  return `HTTP ${res.status}`;
}

// ── Email accounts section ───────────────────────────────────────────────────
//
// Rendered inside the email channel's detail drawer in ChannelSettings.tsx.
// Lists existing Nylas-backed mailboxes and provides an add form.
// All mutations clear the local grant value on success so credentials don't linger
// in component state any longer than necessary.

export function EmailAccountsSection() {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add-form state — kept minimal; grant is cleared after a successful add.
  const [name, setName] = useState('');
  const [selfEmail, setSelfEmail] = useState('');
  const [grantId, setGrantId] = useState('');

  // Monotonic request id: load() runs on mount and after every mutation, so a slow
  // earlier load can resolve after a newer one. Only the latest request is allowed to
  // write state, so a stale response can't clobber a fresh one (e.g. revert a just-added
  // account back to "No accounts yet").
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await apiFetch('/api/registry/email-accounts');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { accounts: EmailAccount[] };
      if (seq !== loadSeq.current) return; // a newer load() started; discard this result
      setAccounts(data.accounts ?? []);
      setErr(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setErr(e instanceof Error ? e.message : 'Failed to load accounts');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // POST /api/registry/email-accounts — create a new account entry.
  const add = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch('/api/registry/email-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, selfEmail, provider: 'nylas', grantId }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      // Clear the form — crucially, drop the grant value so it doesn't sit in state.
      setName('');
      setSelfEmail('');
      setGrantId('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to add account');
    } finally {
      setBusy(false);
    }
  }, [name, selfEmail, grantId, load]);

  // PATCH /api/registry/email-accounts/:name — toggle enabled/disabled.
  const toggle = useCallback(async (acct: EmailAccount) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch(`/api/registry/email-accounts/${encodeURIComponent(acct.name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !acct.enabled }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to update account');
    } finally {
      setBusy(false);
    }
  }, [load]);

  // DELETE /api/registry/email-accounts/:name — remove an account entry.
  const remove = useCallback(async (acct: EmailAccount) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch(`/api/registry/email-accounts/${encodeURIComponent(acct.name)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to remove account');
    } finally {
      setBusy(false);
    }
  }, [load]);

  return (
    <div className="form-field">
      <label>Email accounts</label>
      <p className="settings-page-sub" style={{ margin: '0 0 4px' }}>
        Mailboxes the agent polls and replies from. Adding or removing an account takes effect on the next restart.
      </p>

      {err && <p className="autonomy-error" style={{ margin: '0 0 8px' }}>{err}</p>}

      {/* Account list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {accounts.map(a => (
          <div
            key={a.name}
            className="status-pill"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
          >
            <span>
              <strong>{a.name}</strong>
              {' — '}
              {a.selfEmail}
              {' ('}
              {a.provider}
              {')'}
              {!a.hasGrant && ' ⚠ no grant'}
              {!a.enabled && ' \xb7 disabled'}
            </span>
            <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => void toggle(a)}
              >
                {a.enabled ? 'Disable' : 'Enable'}
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={busy}
                onClick={() => void remove(a)}
              >
                Remove
              </button>
            </span>
          </div>
        ))}
        {accounts.length === 0 && (
          <span className="settings-page-sub">No accounts yet.</span>
        )}
      </div>

      {/* Add-account form */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        <input
          type="text"
          placeholder="account name (e.g. curia)"
          value={name}
          aria-label="Account name"
          onChange={e => setName(e.target.value)}
        />
        <input
          type="email"
          placeholder="mailbox address"
          value={selfEmail}
          aria-label="Mailbox address"
          onChange={e => setSelfEmail(e.target.value)}
        />
        {/* Provider select: Nylas only and disabled — visible to signal the future seam
            where additional providers can be added without a UI redesign. */}
        <label style={{ fontSize: 12 }}>
          Provider
          <select value="nylas" disabled style={{ marginLeft: 6 }}>
            <option value="nylas">Nylas</option>
          </select>
        </label>
        <input
          type="password"
          autoComplete="off"
          placeholder="Nylas grant ID (paste from Nylas dashboard)"
          value={grantId}
          aria-label="Nylas grant ID"
          onChange={e => setGrantId(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !name || !selfEmail || !grantId}
          onClick={() => void add()}
        >
          Add account
        </button>
      </div>
    </div>
  );
}
