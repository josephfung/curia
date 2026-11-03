import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../api.js';

// ── Principal mailbox section ────────────────────────────────────────────────
//
// Rendered inside the email channel's detail drawer in ChannelSettings.tsx (#2409).
// The principal's OWN mailbox — the Nylas grant calendar and the ceo-inbox tools act
// through, and the principal's address — is separate from Curia's email accounts above
// it. These are plain vault keys (ceo_nylas_grant_id, ceo_self_email) that the vault PUT
// route allows; before this an image install could only set them from a source checkout.
// #2361 replaces the grant field with a sign-in link.

interface PrincipalMailboxField {
  key: 'ceo_nylas_grant_id' | 'ceo_self_email';
  label: string;
  secret: boolean;
  placeholder: string;
}

const FIELDS: PrincipalMailboxField[] = [
  {
    key: 'ceo_nylas_grant_id',
    label: 'Nylas grant ID',
    secret: true,
    placeholder: "Grant ID for the principal's mailbox (from the Nylas dashboard)",
  },
  {
    key: 'ceo_self_email',
    label: 'Mailbox address',
    secret: false,
    placeholder: "The principal's email address",
  },
];

// Safe error message extraction — matches the pattern in ChannelSettings.tsx.
async function errorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string };
      if (d.error) return d.error;
    } catch (err) {
      console.error('[PrincipalMailboxSection errorMessage] failed to parse JSON error body:', err);
    }
  }
  return `HTTP ${res.status}`;
}

function PrincipalMailboxRow({ field, configured, onSaved }: {
  field: PrincipalMailboxField;
  configured: boolean;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch(`/api/vault/secrets/${encodeURIComponent(field.key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: value.trim() }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setValue(''); // don't keep the value in component state after a successful save
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  }, [field.key, value, onSaved]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={`status-pill ${configured ? 'confirmed' : 'blocked'}`}>
          {configured ? 'configured' : 'missing'}
        </span>
        <code style={{ fontSize: 13 }}>{field.label}</code>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type={field.secret ? 'password' : 'email'}
          autoComplete="off"
          value={value}
          placeholder={configured ? 'Enter a new value to replace' : field.placeholder}
          aria-label={`Principal mailbox ${field.label}`}
          onChange={e => setValue(e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy || value.trim().length === 0}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
      {err && <p className="autonomy-error" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}

export function PrincipalMailboxSection() {
  const [configuredKeys, setConfiguredKeys] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  // Same stale-response guard as EmailAccountsSection: only the latest load writes state.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await apiFetch('/api/vault/status');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { configured_keys?: string[] };
      if (seq !== loadSeq.current) return;
      setConfiguredKeys(new Set(data.configured_keys ?? []));
      setErr(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setErr(e instanceof Error ? e.message : 'Failed to load vault status');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="form-field">
      <label>Principal's mailbox</label>
      <p className="settings-page-sub" style={{ margin: '0 0 4px' }}>
        The principal's own mailbox, which calendar and the inbox tools work in. It is not
        one of Curia's email accounts above. Changes take effect on the next restart.
      </p>
      {err && <p className="autonomy-error" style={{ margin: '0 0 8px' }}>{err}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {FIELDS.map(field => (
          <PrincipalMailboxRow
            key={field.key}
            field={field}
            configured={configuredKeys.has(field.key)}
            onSaved={() => void load()}
          />
        ))}
      </div>
    </div>
  );
}
