import { useState, useEffect, useCallback } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';

// ── Types (mirror src/channels/credential-resolver.ts CredentialFieldStatus and
//    src/registry/channel-registry-types.ts ChannelRegistryEntry) ──────────────
type ChannelState = 'uninstalled' | 'installed' | 'enabled';
type CredentialSource = 'vault' | 'env' | 'config' | 'missing';

interface CredentialFieldStatus {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
  source: CredentialSource;
}

interface ChannelEntry {
  name: string;
  description: string;
  state: ChannelState;
  isToggleable: boolean;
  credentialFields: CredentialFieldStatus[];
  requiredResolvable: boolean;
  installedAt: string | null;
  installedBy: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
}

// Map each derived state to one of the existing .status-pill modifier classes
// (app.css), matching how RegistrySettings reuses them:
//   enabled     → confirmed (green)
//   installed   → provisional (amber)
//   uninstalled → no modifier (neutral)
const STATE_PILL: Record<ChannelState, string> = {
  enabled:     'confirmed',
  installed:   'provisional',
  uninstalled: '',
};

const STATE_LABEL: Record<ChannelState, string> = {
  uninstalled: 'not installed',
  installed:   'installed',
  enabled:     'enabled',
};

// Safe error message extraction — guards against non-JSON error bodies.
async function errorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string };
      if (d.error) return d.error;
    } catch { /* fall through to HTTP status */ }
  }
  return `HTTP ${res.status}`;
}

// ── Credential row (status + inline entry) ───────────────────────────────────
//
// One credential field. Shows a configured/missing pill plus the resolution source,
// and a masked-or-plain input + Save that PUTs the value to the vault under
// channel.<channel>.<key>. On success it calls onSaved so the page re-reads channel
// status and re-evaluates the Enable gate.

function CredentialRow({ channel, field, onSaved }: {
  channel: string;
  field: CredentialFieldStatus;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      // Credentials are stored in the secrets vault under channel.<name>.<key>.
      const vaultKey = `channel.${channel}.${field.key}`;
      const res = await apiFetch(`/api/vault/secrets/${encodeURIComponent(vaultKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setValue(''); // don't keep the credential in component state after a successful save
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save credential');
    } finally {
      setBusy(false);
    }
  }, [channel, field.key, value, onSaved]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={`status-pill ${field.configured ? 'confirmed' : 'blocked'}`}>
          {field.configured ? `configured (${field.source})` : 'missing'}
        </span>
        <code style={{ fontSize: 13 }}>{field.label}</code>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type={field.secret ? 'password' : 'text'}
          autoComplete="off"
          value={value}
          placeholder={field.configured ? 'Enter a new value to replace' : `Enter ${field.label}`}
          aria-label={`Value for ${field.label}`}
          onChange={e => setValue(e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy || value.length === 0}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
      {err && <p className="autonomy-error" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}

// ── Detail drawer ────────────────────────────────────────────────────────────

function ChannelDrawer({ entry, onClose, onChanged }: {
  entry: ChannelEntry;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Perform a mutating lifecycle call on the channel and refresh the list on success.
  // method+suffix mirrors the registry routes: POST .../install|enable|disable, DELETE base.
  const act = useCallback(async (method: 'POST' | 'DELETE', suffix: string) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch(
        `/api/registry/channels/${encodeURIComponent(entry.name)}${suffix}`,
        { method },
      );
      if (!res.ok) throw new Error(await errorMessage(res));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }, [entry.name, onChanged]);

  const confirmUninstall = () => {
    if (window.confirm(`Uninstall "${entry.name}"? This clears its stored credentials and removes its registry row.`)) {
      void act('DELETE', '');
    }
  };

  // Non-toggleable channels (http, cli) are always on: no credential form, no
  // lifecycle actions, and the Enable gate doesn't apply.
  const locked = !entry.isToggleable;

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div className="drawer-header-top">
          <span>channel</span>
          <button
            type="button"
            className="drawer-close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <h2 className="drawer-title-h2">{entry.name}</h2>
      </div>

      <div className="drawer-body">
        <div className="edit-drawer-form">
          <p className="settings-page-sub" style={{ margin: 0 }}>
            Enabling or disabling takes effect on the next restart.
          </p>

          {err && <p className="autonomy-error">{err}</p>}

          <div className="form-field">
            <label>State</label>
            {locked ? (
              <span className="status-pill confirmed">Always on</span>
            ) : (
              <span className={`status-pill ${STATE_PILL[entry.state]}`}>{STATE_LABEL[entry.state]}</span>
            )}
          </div>

          <div className="form-field">
            <label>Description</label>
            <div>{entry.description}</div>
          </div>

          {/* Credential form — only for toggleable channels that declare fields.
              Always-on channels (http, cli) have no credentials. */}
          {!locked && entry.credentialFields.length > 0 && (
            <div className="form-field">
              <label>Credentials</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {entry.credentialFields.map(field => (
                  <CredentialRow
                    key={field.key}
                    channel={entry.name}
                    field={field}
                    onSaved={onChanged}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="form-field">
            <label>Installed</label>
            <div>
              {entry.installedAt
                ? `${entry.installedAt} by ${entry.installedBy}`
                : '—'}
            </div>
          </div>
          <div className="form-field">
            <label>Enabled</label>
            <div>
              {entry.enabledAt
                ? `${entry.enabledAt} by ${entry.enabledBy}`
                : '—'}
            </div>
          </div>
        </div>
      </div>

      {/* Lifecycle actions — hidden entirely for non-toggleable channels. */}
      {!locked && (
        <div className="drawer-footer">
          {/* Install — only when not yet in the registry. */}
          {entry.state === 'uninstalled' && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => void act('POST', '/install')}
            >
              Install
            </button>
          )}

          {/* Enable — only for installed (but not yet enabled) channels. Gated on
              required credentials resolving, mirroring the service-level guard. */}
          {entry.state === 'installed' && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !entry.requiredResolvable}
              title={entry.requiredResolvable ? undefined : 'Configure the required credentials first'}
              onClick={() => void act('POST', '/enable')}
            >
              Enable
            </button>
          )}

          {/* Disable — only for currently-enabled channels. */}
          {entry.state === 'enabled' && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => void act('POST', '/disable')}
            >
              Disable
            </button>
          )}

          {/* Uninstall — available for any channel that has a registry row. */}
          {entry.state !== 'uninstalled' && (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busy}
              onClick={confirmUninstall}
            >
              Uninstall
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

// ── Channels page ─────────────────────────────────────────────────────────────
//
// Mirrors the RegistrySettings (Skills/Agents) layout: its own sidebar + topbar, a
// records table of channels with state pills, and a detail drawer with a credential
// form + lifecycle actions. The catalog is small (four channels), so there is no
// search or pagination.

export function ChannelsPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  const [entries, setEntries] = useState<ChannelEntry[]>([]);
  const [selected, setSelected] = useState<ChannelEntry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/registry/channels');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { channels: ChannelEntry[] };
      const list = data.channels ?? [];
      setEntries(list);
      setLoadError(null); // clear any prior error on successful reload
      // Keep the drawer in sync with the freshly-loaded state so action buttons and
      // credential pills reflect the true current state after a transition.
      setSelected(prev =>
        prev ? list.find(e => e.name === prev.name) ?? null : null,
      );
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="channels" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}
        <main className="main">
          <Topbar crumb="Settings" title="Channels" />

          {loadError ? (
            <div style={{ padding: 32, color: 'var(--app-destructive)', fontSize: 13 }}>{loadError}</div>
          ) : (
            <div className="records-layout">
              <div className="records-main">
                <div className="records-table-wrap">
                  <table className="records-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>State</th>
                        <th>Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map(e => (
                        <tr
                          key={e.name}
                          className={selected?.name === e.name ? 'active' : undefined}
                          onClick={() => setSelected(e)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td>{e.name}</td>
                          <td>
                            {/* Non-toggleable channels (http, cli) are always on. */}
                            {e.isToggleable ? (
                              <span className={`status-pill ${STATE_PILL[e.state]}`}>{STATE_LABEL[e.state]}</span>
                            ) : (
                              <span className="status-pill confirmed">Always on</span>
                            )}
                          </td>
                          <td>{e.description}</td>
                        </tr>
                      ))}
                      {entries.length === 0 && (
                        <tr>
                          <td colSpan={3} style={{ textAlign: 'center', padding: 40, color: 'var(--app-fg-muted)' }}>
                            No channels.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {selected && (
                <ChannelDrawer
                  key={selected.name}
                  entry={selected}
                  onClose={() => setSelected(null)}
                  onChanged={() => { void load(); }}
                />
              )}
            </div>
          )}
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
