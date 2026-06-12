import { useState, useEffect, useMemo, useCallback } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar, TopbarSearch } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';

// ── Types (mirror src/registry/types.ts RegistryEntry) ──────────────────────
type DerivedState = 'uninstalled' | 'installed' | 'enabled' | 'ghost';

interface ManifestMetadata {
  name: string;
  description: string;
  version: string;
  actionRisk?: string | number;
  sensitivity?: string;
  capabilities?: string[];
  role?: string;
  modelTier?: string;
  memoryScopes?: string[];
  // PR2 (#939): vault keys a skill declares in install.requires_secrets. Cross-referenced
  // against GET /api/vault/status to show configured/missing status and gate install/enable.
  requiresSecrets?: string[];
}

interface RegistryEntry {
  name: string;
  kind: 'skill' | 'agent';
  state: DerivedState;
  metadata: ManifestMetadata | null;
  manifestError?: string;
  installedAt: string | null;
  installedBy: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
}

// Map each DerivedState to one of the existing .status-pill modifier classes
// (app.css) so no new CSS is needed:
//   enabled     → confirmed (green)
//   installed   → provisional (amber)
//   ghost       → blocked (red) — manifest present on disk but DB row is gone
//   uninstalled → no modifier (neutral)
const STATE_PILL: Record<DerivedState, string> = {
  enabled:     'confirmed',
  installed:   'provisional',
  ghost:       'blocked',
  uninstalled: '',
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

// ── Required-secret row (status + inline entry) ──────────────────────────────
//
// One required vault key. Shows a configured/missing pill; when missing, offers a
// masked input + Save that PUTs the value to /api/vault/secrets/:name. On success it
// calls onSaved so the drawer re-reads vault status and re-evaluates the install gate.

function SecretRow({ name, configured, onSaved }: {
  name: string;
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
      const res = await apiFetch(`/api/vault/secrets/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setValue(''); // don't keep the secret in component state after a successful save
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save secret');
    } finally {
      setBusy(false);
    }
  }, [name, value, onSaved]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={`status-pill ${configured ? 'confirmed' : 'blocked'}`}>
          {configured ? 'configured' : 'missing'}
        </span>
        <code style={{ fontSize: 13 }}>{name}</code>
      </div>
      {!configured && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="password"
            autoComplete="off"
            value={value}
            placeholder={`Enter ${name}`}
            aria-label={`Secret value for ${name}`}
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
      )}
      {err && <p className="autonomy-error" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}

// ── Detail drawer ────────────────────────────────────────────────────────────

function RegistryDrawer({ entry, kindPath, onClose, onChanged }: {
  entry: RegistryEntry;
  kindPath: 'skills' | 'agents';
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // PR2 (#939): required-secrets gate. Only skills declare install.requires_secrets.
  const required = entry.kind === 'skill' ? (entry.metadata?.requiresSecrets ?? []) : [];
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [secretsErr, setSecretsErr] = useState<string | null>(null);

  // Read which vault keys are configured so we can show per-secret status and gate the
  // install/enable actions. Fail closed: if the status read fails we treat everything as
  // unconfigured (the gate stays on) rather than letting an install slip through.
  const loadVaultStatus = useCallback(async () => {
    if (required.length === 0) return;
    try {
      const res = await apiFetch('/api/vault/status');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { configured_keys?: string[] };
      setConfigured(new Set(data.configured_keys ?? []));
      setSecretsErr(null);
    } catch (e) {
      setConfigured(new Set());
      setSecretsErr(e instanceof Error ? e.message : 'Failed to load secret status');
    }
  }, [required.length]);

  useEffect(() => { void loadVaultStatus(); }, [loadVaultStatus]);

  const missingSecrets = required.filter(s => !configured.has(s));
  // Block install/enable while any required secret is unconfigured — mirrors the
  // service-level gate so the UI never offers an action the backend will reject.
  const secretsBlock = missingSecrets.length > 0;
  const secretsBlockTitle = secretsBlock
    ? `Configure required secret(s) first: ${missingSecrets.join(', ')}`
    : undefined;

  // Perform a mutating API call on the entry and refresh the list on success.
  const act = useCallback(async (method: 'POST' | 'DELETE', suffix: string) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch(
        `/api/registry/${kindPath}/${encodeURIComponent(entry.name)}${suffix}`,
        { method },
      );
      if (!res.ok) throw new Error(await errorMessage(res));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }, [entry.name, kindPath, onChanged]);

  const confirmUninstall = () => {
    if (window.confirm(`Uninstall "${entry.name}"? This removes its registry row.`)) {
      void act('DELETE', '');
    }
  };

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div className="drawer-header-top">
          <span>{entry.kind}</span>
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

          {entry.manifestError && (
            <p className="autonomy-error">Manifest error: {entry.manifestError}</p>
          )}
          {err && <p className="autonomy-error">{err}</p>}

          <div className="form-field">
            <label>State</label>
            <span className={`status-pill ${STATE_PILL[entry.state]}`}>{entry.state}</span>
          </div>

          {entry.metadata && (
            <>
              <div className="form-field">
                <label>Description</label>
                <div>{entry.metadata.description}</div>
              </div>
              <div className="form-field">
                <label>Version</label>
                <div>{entry.metadata.version}</div>
              </div>
              {entry.kind === 'skill' && (
                <>
                  <div className="form-field">
                    <label>Action risk</label>
                    <div>{String(entry.metadata.actionRisk ?? '—')}</div>
                  </div>
                  <div className="form-field">
                    <label>Sensitivity</label>
                    <div>{entry.metadata.sensitivity ?? '—'}</div>
                  </div>
                </>
              )}
              {entry.kind === 'agent' && (
                <>
                  <div className="form-field">
                    <label>Role / model</label>
                    <div>{entry.metadata.role ?? '—'} / {entry.metadata.modelTier ?? '—'}</div>
                  </div>
                  <div className="form-field">
                    <label>Memory scopes</label>
                    <div>{entry.metadata.memoryScopes?.join(', ') || '—'}</div>
                  </div>
                </>
              )}
              {entry.metadata.capabilities && (
                <div className="form-field">
                  <label>Capabilities</label>
                  <div>{entry.metadata.capabilities.join(', ') || '—'}</div>
                </div>
              )}
            </>
          )}

          {required.length > 0 && (
            <div className="form-field">
              <label>Required secrets</label>
              {secretsErr && <p className="autonomy-error" style={{ margin: 0 }}>{secretsErr}</p>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {required.map(name => (
                  <SecretRow
                    key={name}
                    name={name}
                    configured={configured.has(name)}
                    onSaved={() => { void loadVaultStatus(); }}
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

      <div className="drawer-footer">
        {/* Install actions — only shown when not yet in the registry */}
        {entry.state === 'uninstalled' && (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy || secretsBlock}
              title={secretsBlockTitle}
              onClick={() => void act('POST', '/install')}
            >
              Install
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || secretsBlock}
              title={secretsBlockTitle}
              onClick={() => void act('POST', '/install-enable')}
            >
              Install &amp; enable
            </button>
          </>
        )}

        {/* Enable — only for installed (but not yet enabled) entries */}
        {entry.state === 'installed' && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || secretsBlock}
            title={secretsBlockTitle}
            onClick={() => void act('POST', '/enable')}
          >
            Enable
          </button>
        )}

        {/* Disable — only for currently-enabled entries */}
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

        {/* Uninstall — available for any entry that has a registry row */}
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
    </aside>
  );
}

// ── Pagination ───────────────────────────────────────────────────────────────
//
// Local copy of the Contacts/Tasks pagination control — the codebase keeps one
// per records page rather than sharing a single component.

interface PaginationProps {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
}

function Pagination({ total, page, pageSize, totalPages, onPage, onPageSize }: PaginationProps) {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  const pages: number[] = [];
  for (let i = 1; i <= totalPages; i++) pages.push(i);

  return (
    <div className="records-pagination">
      <div className="records-pagination-info">
        Showing <strong style={{ color: 'var(--app-fg)' }}>{start}–{end}</strong> of {total}
      </div>
      <div className="records-page-size">
        Rows
        <select value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>
          <option value="10">10</option>
          <option value="25">25</option>
          <option value="50">50</option>
        </select>
      </div>
      <div className="records-pagination-controls">
        <button className="records-page-btn" onClick={() => onPage(page - 1)} disabled={page <= 1}>‹</button>
        {pages.map(p => (
          <button key={p} className={`records-page-btn${p === page ? ' active' : ''}`} onClick={() => onPage(p)}>{p}</button>
        ))}
        <button className="records-page-btn" onClick={() => onPage(page + 1)} disabled={page >= totalPages}>›</button>
      </div>
    </div>
  );
}

// ── Standalone registry page (Skills / Agents) ───────────────────────────────
//
// Mirrors the Contacts/Tasks layout: its own sidebar + topbar (with search), a
// records table, and pagination. Skills and Agents used to render inside the
// settings shell; they are now top-level pages reachable directly from the
// sidebar's Settings group.

function RegistryPage({ kind }: { kind: 'skill' | 'agent' }) {
  const kindPath = kind === 'skill' ? 'skills' : 'agents';
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [selected, setSelected] = useState<RegistryEntry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/registry/${kindPath}`);
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as Record<string, RegistryEntry[]>;
      const list = data[kindPath] ?? [];
      setEntries(list);
      setLoadError(null); // clear any prior error on successful reload
      // Keep the drawer in sync with the freshly-loaded state so action
      // buttons reflect the true current state after a transition.
      setSelected(prev =>
        prev ? list.find(e => e.name === prev.name) ?? null : null,
      );
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, [kindPath]);

  useEffect(() => { void load(); }, [load]);

  // Search filters on name + description; pagination is applied to the result.
  const filtered = useMemo(() => {
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter(e =>
      (e.name + ' ' + (e.metadata?.description ?? '')).toLowerCase().includes(q),
    );
  }, [entries, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const title = kind === 'skill' ? 'Skills' : 'Agents';
  // Name, State, two kind-specific columns, Version.
  const colCount = 5;

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView={kindPath} theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}
        <main className="main">
          <Topbar crumb="Settings" title={title}>
            <TopbarSearch
              placeholder={`Search ${kindPath}…`}
              value={search}
              onChange={v => { setSearch(v); setPage(1); }}
            />
          </Topbar>

          {loadError ? (
            <div style={{ padding: 32, color: 'var(--app-destructive)', fontSize: 13 }}>{loadError}</div>
          ) : (
            <>
              {/* Mobile search — TopbarSearch is hidden below 768px by the shared stylesheet */}
              <div className="contacts-mobile-search">
                <input
                  type="text"
                  placeholder={`Search ${kindPath}…`}
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(1); }}
                />
              </div>

              <div className="records-layout">
                <div className="records-main">
                  <div className="records-table-wrap">
                    <table className="records-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>State</th>
                          {kind === 'agent' ? (
                            <>
                              <th>Model tier</th>
                              <th>Memory scopes</th>
                            </>
                          ) : (
                            <>
                              <th>Action risk</th>
                              <th>Sensitivity</th>
                            </>
                          )}
                          <th>Version</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map(e => (
                          <tr
                            key={e.name}
                            className={selected?.name === e.name ? 'active' : undefined}
                            onClick={() => setSelected(e)}
                            style={{ cursor: 'pointer' }}
                          >
                            {/* Warn icon if the manifest failed to parse */}
                            <td>{e.name}{e.manifestError ? ' ⚠' : ''}</td>
                            <td>
                              <span className={`status-pill ${STATE_PILL[e.state]}`}>
                                {/* Extra warning on ghost: manifest is gone but DB row lingers */}
                                {e.state}{e.state === 'ghost' ? ' ⚠' : ''}
                              </span>
                            </td>
                            {kind === 'agent' ? (
                              <>
                                <td>{e.metadata?.modelTier ?? '—'}</td>
                                <td>{e.metadata?.memoryScopes?.join(', ') || '—'}</td>
                              </>
                            ) : (
                              <>
                                {/* actionRisk may be 0 (a valid risk score), so guard on null, not falsy. */}
                                <td>{e.metadata?.actionRisk != null ? String(e.metadata.actionRisk) : '—'}</td>
                                <td>{e.metadata?.sensitivity ?? '—'}</td>
                              </>
                            )}
                            <td>{e.metadata?.version ?? '—'}</td>
                          </tr>
                        ))}
                        {pageRows.length === 0 && (
                          <tr>
                            <td colSpan={colCount} style={{ textAlign: 'center', padding: 40, color: 'var(--app-fg-muted)' }}>
                              No {kindPath} match.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    total={filtered.length}
                    page={safePage}
                    pageSize={pageSize}
                    totalPages={totalPages}
                    onPage={setPage}
                    onPageSize={n => { setPageSize(n); setPage(1); }}
                  />
                </div>

                {selected && (
                  <RegistryDrawer
                    key={selected.name}
                    entry={selected}
                    kindPath={kindPath}
                    onClose={() => setSelected(null)}
                    onChanged={() => { void load(); }}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}

// ── Exported page components (one per route) ─────────────────────────────────

export function SkillsPage() {
  return <RegistryPage kind="skill" />;
}

export function AgentsPage() {
  return <RegistryPage kind="agent" />;
}
