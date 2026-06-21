import { useState, useEffect, useCallback, useMemo } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';

type McpState = 'uninstalled' | 'installed' | 'enabled';

interface McpSecretField {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
}

interface McpEntry {
  name: string;
  state: McpState;
  secretFields: McpSecretField[];
  requiredResolvable: boolean;
  installedAt: string | null;
  installedBy: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
}

const STATE_PILL: Record<McpState, string> = {
  enabled:     'confirmed',
  installed:   'provisional',
  uninstalled: '',
};

const STATE_LABEL: Record<McpState, string> = {
  uninstalled: 'not installed',
  installed:   'installed',
  enabled:     'enabled',
};

async function errorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string };
      if (d.error) return d.error;
    } catch (err) {
      console.error('[errorMessage] failed to parse JSON error body:', err);
    }
  }
  return `HTTP ${res.status}`;
}

// Credential row — identical to ChannelSettings.CredentialRow but uses the flat vault key directly.
function SecretRow({ field, onSaved }: { field: McpSecretField; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      // MCP secrets are stored under the flat vault key (no channel.* namespace).
      const res = await apiFetch(`/api/vault/secrets/${encodeURIComponent(field.key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setValue('');
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save credential');
    } finally {
      setBusy(false);
    }
  }, [field.key, value, onSaved]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={`status-pill ${field.configured ? 'confirmed' : 'blocked'}`}>
          {field.configured ? 'configured' : 'missing'}
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

function McpDrawer({ entry, onClose, onChanged }: { entry: McpEntry; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = useCallback(async (method: 'POST' | 'DELETE', suffix: string) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch(
        `/api/registry/mcp/${encodeURIComponent(entry.name)}${suffix}`,
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
    if (window.confirm(`Uninstall "${entry.name}"? This clears its exclusively-owned vault secrets and removes its registry row.`)) {
      void act('DELETE', '');
    }
  };

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div className="drawer-header-top">
          <span>mcp server</span>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
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
            Enable/disable changes take effect on the next restart.
          </p>
          {err && <p className="autonomy-error">{err}</p>}

          <div className="form-field">
            <label>State</label>
            <span className={`status-pill ${STATE_PILL[entry.state]}`}>{STATE_LABEL[entry.state]}</span>
          </div>

          {entry.secretFields.length > 0 && (
            <div className="form-field">
              <label>Credentials</label>
              <p className="settings-page-sub" style={{ margin: '0 0 4px' }}>
                Saved credentials take effect on the next restart.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {entry.secretFields.map(field => (
                  <SecretRow key={field.key} field={field} onSaved={onChanged} />
                ))}
              </div>
            </div>
          )}

          <div className="form-field">
            <label>Installed</label>
            <div>{entry.installedAt ? `${entry.installedAt} by ${entry.installedBy}` : '—'}</div>
          </div>
          <div className="form-field">
            <label>Enabled</label>
            <div>{entry.enabledAt ? `${entry.enabledAt} by ${entry.enabledBy}` : '—'}</div>
          </div>
        </div>
      </div>

      <div className="drawer-footer">
        {entry.state === 'uninstalled' && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
            onClick={() => void act('POST', '/install')}>Install</button>
        )}
        {entry.state === 'installed' && (
          <button type="button" className="btn btn-primary btn-sm"
            disabled={busy || !entry.requiredResolvable}
            title={entry.requiredResolvable ? undefined : 'Configure the required credentials first'}
            onClick={() => void act('POST', '/enable')}>Enable</button>
        )}
        {entry.state === 'enabled' && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
            onClick={() => void act('POST', '/disable')}>Disable</button>
        )}
        {entry.state !== 'uninstalled' && (
          <button type="button" className="btn btn-danger btn-sm" disabled={busy}
            onClick={confirmUninstall}>Uninstall</button>
        )}
      </div>
    </aside>
  );
}

type McpSortKey = 'name' | 'state';

function serverSortValue(e: McpEntry, key: McpSortKey): string {
  return key === 'name' ? e.name : e.state;
}

export default function McpSkillsPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [entries, setEntries] = useState<McpEntry[]>([]);
  const [selected, setSelected] = useState<McpEntry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: McpSortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [stateFilter, setStateFilter] = useState<'all' | McpState>('all');

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/registry/mcp');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { servers: McpEntry[] };
      const list = data.servers ?? [];
      setEntries(list);
      setLoadError(null);
      setSelected(prev => prev ? list.find(e => e.name === prev.name) ?? null : null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => ({
    all:         entries.length,
    enabled:     entries.filter(e => e.state === 'enabled').length,
    installed:   entries.filter(e => e.state === 'installed').length,
    uninstalled: entries.filter(e => e.state === 'uninstalled').length,
  }), [entries]);

  const filtered = useMemo(() => {
    const rows = stateFilter === 'all' ? entries : entries.filter(e => e.state === stateFilter);
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = serverSortValue(a, sort.key);
      const bv = serverSortValue(b, sort.key);
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      return 0;
    });
  }, [entries, stateFilter, sort]);

  function toggleSort(key: McpSortKey) {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
  }
  const sortArrow = (key: McpSortKey) => sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '';

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="mcp-skills" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />
        )}
        <main className="main">
          <Topbar crumb="Settings" title="MCP Skills" />
          {loadError ? (
            <div style={{ padding: 32, color: 'var(--app-destructive)', fontSize: 13 }}>{loadError}</div>
          ) : (
            <>
              <div className="records-toolbar">
                <div className="records-toolbar-left">
                  {(['all', 'enabled', 'installed', 'uninstalled'] as const).map(v => (
                    <button key={v} className={`records-filter-chip${stateFilter === v ? ' active' : ''}`}
                      onClick={() => setStateFilter(v)}>
                      {v === 'all' ? 'All' : v.charAt(0).toUpperCase() + v.slice(1)}
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, opacity: 0.7 }}>
                        {counts[v as keyof typeof counts]}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="records-toolbar-right">
                  <span className="topbar-meta">{filtered.length} of {entries.length}</span>
                </div>
              </div>
              <div className="records-layout">
                <div className="records-main">
                  <div className="records-table-wrap">
                    <table className="records-table">
                      <thead>
                        <tr>
                          <th className="sortable" aria-sort={sort.key === 'name' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('name')}>
                              Name <span className="sort-arrow">{sortArrow('name')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={sort.key === 'state' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('state')}>
                              State <span className="sort-arrow">{sortArrow('state')}</span>
                            </button>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map(e => (
                          <tr key={e.name} className={selected?.name === e.name ? 'active' : undefined}
                            onClick={() => setSelected(e)} style={{ cursor: 'pointer' }}>
                            <td>{e.name}</td>
                            <td><span className={`status-pill ${STATE_PILL[e.state]}`}>{STATE_LABEL[e.state]}</span></td>
                          </tr>
                        ))}
                        {filtered.length === 0 && (
                          <tr>
                            <td colSpan={2} style={{ textAlign: 'center', padding: 40, color: 'var(--app-fg-muted)' }}>
                              No MCP servers configured.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
                {selected && (
                  <McpDrawer key={selected.name} entry={selected} onClose={() => setSelected(null)} onChanged={() => { void load(); }} />
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
