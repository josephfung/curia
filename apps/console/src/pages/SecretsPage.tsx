import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';
import { declarerLabel, errorMessage, removeSecretFlow, type SecretRowData } from './secrets-utils.js';

// One vault secret. The page never receives a value: it shows set / not set, and the
// entry field is write-only and cleared after a save (#2453).
function SecretRow({ row, onChanged }: { row: SecretRowData; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch(`/api/vault/secrets/${encodeURIComponent(row.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setValue('');
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save secret');
    } finally {
      setBusy(false);
    }
  }, [row.name, value, onChanged]);

  // Two confirmations, the second only when the server says something enabled needs the
  // key (removeSecretFlow).
  const remove = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const outcome = await removeSecretFlow(row.name, {
        confirm: message => window.confirm(message),
        del: force => apiFetch(`/api/vault/secrets/${encodeURIComponent(row.name)}${force ? '?force=true' : ''}`, { method: 'DELETE' }),
      });
      if (outcome === 'removed') onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to remove secret');
    } finally {
      setBusy(false);
    }
  }, [row.name, onChanged]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 20px', borderTop: '1px solid var(--app-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <code style={{ fontSize: 13 }}>{row.name}</code>
        {/* Red only when something enabled is missing the key and nothing else supplies it. */}
        <span className={`status-pill ${row.configured ? 'confirmed' : row.envFallback ? 'provisional' : row.required ? 'blocked' : ''}`}>
          {row.configured ? 'configured' : row.envFallback ? 'from environment' : row.required ? 'missing' : 'not set'}
        </span>
        <span className="settings-muted-hint">{row.required ? 'required' : 'optional'}</span>
        <span style={{ flex: 1 }} />
        {!editing && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setEditing(true)}>
            {row.configured ? 'Replace' : 'Set'}
          </button>
        )}
        {row.configured && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
        )}
      </div>
      <p className="settings-page-sub" style={{ margin: 0, fontSize: 12 }}>
        {row.declaredBy.map(declarerLabel).join(', ')}
      </p>
      {row.envFallback && (
        <p className="settings-page-sub" style={{ margin: 0, fontSize: 12 }}>
          Supplied by the {row.envFallback} environment variable. Setting a value here takes precedence;
          removing it here does not clear the variable.
        </p>
      )}
      {row.declaredBy.filter(d => d.purpose).map(d => (
        <p key={d.name} className="settings-page-sub" style={{ margin: 0, fontSize: 12 }}>{d.purpose}</p>
      ))}
      {editing && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="password"
            autoComplete="off"
            value={value}
            placeholder={`Enter ${row.name}`}
            aria-label={`Secret value for ${row.name}`}
            onChange={e => setValue(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || value.length === 0} onClick={() => void save()}>
            Save
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setEditing(false); setValue(''); }}>
            Cancel
          </button>
        </div>
      )}
      {err && <p className="autonomy-error" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}

export function SecretsPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [rows, setRows] = useState<SecretRowData[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Two refreshes can overlap (a second Remove while the first reload is pending); only the
  // newest request's response is applied, so an older list can't land last.
  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const id = ++latestLoad.current;
    try {
      const res = await apiFetch('/api/vault/secrets');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { secrets?: SecretRowData[] };
      if (id !== latestLoad.current) return;
      setRows(data.secrets ?? []);
      setLoadError(null);
    } catch (e) {
      if (id !== latestLoad.current) return;
      setLoadError(e instanceof Error ? e.message : 'Failed to load secrets');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  // Needed first, then optional; alphabetical within each (the API already sorts by name).
  const sorted = useMemo(
    () => [...(rows ?? [])].sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name)),
    [rows],
  );

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="secrets" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />
        )}
        <main className="main">
          <Topbar crumb="Memory" title="Secrets" />
          {loadError ? (
            <div style={{ padding: 32, color: 'var(--app-destructive)', fontSize: 13 }}>
              <p style={{ margin: '0 0 12px' }}>{loadError}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>Retry</button>
            </div>
          ) : rows === null ? (
            <div style={{ padding: 32 }}><p className="settings-muted-hint">Loading…</p></div>
          ) : (
            <div style={{ padding: '24px 32px' }}>
              <p className="settings-page-sub" style={{ marginBottom: 16 }}>
                Credentials Curia uses. Values are write-only: they are stored encrypted and never shown here.
              </p>
              <section className="settings-section" style={{ maxWidth: 900 }}>
                <div className="settings-section-head">
                  <h3 className="settings-section-title">Secrets</h3>
                  <p className="settings-section-sub">
                    {sorted.filter(r => r.configured).length} of {sorted.length} set
                  </p>
                </div>
                {sorted.map(row => <SecretRow key={row.name} row={row} onChanged={() => void load()} />)}
              </section>
            </div>
          )}
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}

export default SecretsPage;
