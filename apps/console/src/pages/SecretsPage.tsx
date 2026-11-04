import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar, TopbarSearch, TopbarDivider } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';
import {
  declarerLabel,
  duplicateSiteHints,
  errorMessage,
  filterCounts,
  filterSecrets,
  lastUsedText,
  siteHost,
  sortSecrets,
  type SecretFilters,
  type SecretKind,
  type SecretRowData,
  type SecretSortKey,
  type SecretStatus,
} from './secrets-utils.js';
import {
  KIND_LABEL,
  STATUS_LABEL,
  SecretCreateDrawer,
  SecretEditDrawer,
  SecretViewDrawer,
  StatusPill,
  shortDate,
} from './SecretsDrawers.js';

// Every credential Curia holds, as one records table (#2453): personal sign-ins, system keys
// declared by tools/channels/MCP servers, and platform keys managed by the deployment. The page
// never receives a value; the drawers write values but never read them back.

// Which drawer (if any) is open. `view` is read-only; `edit`/`create` show a form.
type DrawerMode = 'view' | 'edit' | 'create' | null;

type Sort = { key: SecretSortKey; dir: 'asc' | 'desc' } | null;

const KIND_CHIPS: ReadonlyArray<[SecretKind | 'all', string]> = [
  ['all', 'All'], ['personal', 'Personal'], ['system', 'System'], ['platform', 'Platform'],
];
const STATUS_CHIPS: ReadonlyArray<SecretStatus> = ['configured', 'env', 'missing', 'not_set', 'not_declared'];
const REQUIRED_CHIPS: ReadonlyArray<['required' | 'optional', string]> = [['required', 'Required'], ['optional', 'Optional']];

const SEARCH_PLACEHOLDER = 'Search name, site, username…';

function UsedFor({ row, sameSite }: { row: SecretRowData; sameSite: string[] | undefined }) {
  if (row.kind === 'personal') {
    const host = siteHost(row.loginUrl);
    return (
      <>
        {host ?? (row.loginUrl || <span className="cell-muted">No sign-in site saved</span>)}
        {row.username && <span className="secrets-cell-sub">{row.username}</span>}
        {sameSite?.map(other => (
          <span key={other} className="secrets-cell-sub secrets-warn">⚠ same site as {other}</span>
        ))}
      </>
    );
  }
  if (row.declaredBy.length === 0) return <span className="cell-muted">Nothing declares it</span>;
  return <>{row.declaredBy.map(declarerLabel).join(', ')}</>;
}

function NameCell({ row }: { row: SecretRowData }) {
  return (
    <>
      <code className="secrets-name">
        {row.kind === 'platform' && <span aria-hidden="true">🔒 </span>}
        {row.name}
      </code>
      {row.kind === 'system' && row.declaredBy.length > 0 && (
        <span className="secrets-cell-sub">{row.required ? 'Required' : 'Optional'}</span>
      )}
      {row.kind === 'platform' && <span className="secrets-cell-sub">Managed by deployment</span>}
    </>
  );
}

export function SecretsPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [rows, setRows] = useState<SecretRowData[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState<SecretFilters>({ kind: 'all', status: 'all', required: 'all', search: '' });
  const [sort, setSort] = useState<Sort>(null);
  const [drawerMode, setDrawerMode] = useState<DrawerMode>(null);
  const [selected, setSelected] = useState<SecretRowData | null>(null);

  // Two refreshes can overlap (a save while the previous reload is pending); only the newest
  // request's response is applied, so an older list can't land last. Resolves to the fresh list.
  const latestLoad = useRef(0);
  const load = useCallback(async (): Promise<SecretRowData[] | null> => {
    const id = ++latestLoad.current;
    try {
      const res = await apiFetch('/api/vault/secrets');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { secrets?: SecretRowData[] };
      if (id !== latestLoad.current) return null;
      const fresh = data.secrets ?? [];
      setRows(fresh);
      setLoadError(null);
      return fresh;
    } catch (e) {
      console.error('[SecretsPage] load failed:', e);
      if (id !== latestLoad.current) return null;
      setLoadError(e instanceof Error ? e.message : 'Failed to load secrets');
      return null;
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  const all = useMemo(() => rows ?? [], [rows]);
  const counts = useMemo(() => filterCounts(all), [all]);
  const hints = useMemo(() => duplicateSiteHints(all), [all]);
  const visible = useMemo(() => sortSecrets(filterSecrets(all, filters), sort), [all, filters, sort]);
  const now = new Date();

  // Single-select chips; clicking the active one clears that group.
  function setFilter<K extends 'kind' | 'status' | 'required'>(key: K, value: SecretFilters[K]) {
    setFilters(f => ({ ...f, [key]: f[key] === value ? 'all' : value }));
  }

  function toggleSort(key: SecretSortKey) {
    setSort(s => s?.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' });
  }
  const ariaSort = (key: SecretSortKey) => sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const sortArrow = (key: SecretSortKey) => sort?.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '';

  function sortHeader(key: SecretSortKey, label: string, className = '') {
    return (
      <th className={`sortable ${className}`.trim()} aria-sort={ariaSort(key)}>
        <button className="sort-btn" onClick={() => toggleSort(key)}>
          {label} <span className="sort-arrow">{sortArrow(key)}</span>
        </button>
      </th>
    );
  }

  function openView(row: SecretRowData) {
    setSelected(row);
    setDrawerMode('view');
  }

  function openEdit(row: SecretRowData) {
    setSelected(row);
    setDrawerMode('edit');
  }

  function closeDrawer() {
    setSelected(null);
    setDrawerMode(null);
  }

  // After an edit, return to View showing the reloaded row (it may now be configured).
  async function handleEdited(name: string) {
    const fresh = await load();
    const row = fresh?.find(r => r.name === name) ?? null;
    setSelected(row);
    setDrawerMode(row ? 'view' : null);
  }

  function handleChanged() {
    closeDrawer();
    void load();
  }

  const chip = (active: boolean, label: string, count: number, onClick: () => void, key: string) => (
    <button key={key} className={`records-filter-chip${active ? ' active' : ''}`} onClick={onClick}>
      {label}
      <span className="records-chip-count">{count}</span>
    </button>
  );

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="secrets" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />
        )}
        <main className="main">
          <Topbar crumb="Memory" title="Secrets">
            <TopbarSearch
              placeholder={SEARCH_PLACEHOLDER}
              value={filters.search}
              onChange={v => setFilters(f => ({ ...f, search: v }))}
            />
            <TopbarDivider />
            <button
              className="btn btn-primary btn-sm"
              onClick={() => { setSelected(null); setDrawerMode('create'); }}
            >
              + New secret
            </button>
          </Topbar>

          {loadError ? (
            <div style={{ padding: 32, color: 'var(--app-destructive)', fontSize: 13 }}>
              <p style={{ margin: '0 0 12px' }}>{loadError}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>Retry</button>
            </div>
          ) : (
            <>
              {/* Mobile search — TopbarSearch is hidden below 768px by the shared stylesheet */}
              <div className="contacts-mobile-search">
                <input
                  type="text"
                  placeholder={SEARCH_PLACEHOLDER}
                  value={filters.search}
                  onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
                />
              </div>

              <div className="records-toolbar">
                <div className="records-toolbar-left records-chip-groups">
                  <div className="records-chip-group" role="group" aria-label="Kind">
                    <span className="records-chip-group-label">Kind</span>
                    {KIND_CHIPS.map(([v, label]) => chip(
                      filters.kind === v, label, counts.kind[v],
                      () => setFilters(f => ({ ...f, kind: v })), v,
                    ))}
                  </div>
                  <div className="records-chip-group" role="group" aria-label="Status">
                    <span className="records-chip-group-label">Status</span>
                    {STATUS_CHIPS.map(v => chip(
                      filters.status === v, STATUS_LABEL[v], counts.status[v], () => setFilter('status', v), v,
                    ))}
                  </div>
                  <div className="records-chip-group" role="group" aria-label="Required">
                    <span className="records-chip-group-label">Required</span>
                    {REQUIRED_CHIPS.map(([v, label]) => chip(
                      filters.required === v, label, counts.required[v], () => setFilter('required', v), v,
                    ))}
                  </div>
                </div>
                <div className="records-toolbar-right">
                  <span className="topbar-meta">{visible.length} of {all.length}</span>
                </div>
              </div>

              <div className="records-layout">
                <div className="records-main">
                  <div className="records-table-wrap">
                    <table className="records-table secrets-table">
                      <thead>
                        <tr>
                          {sortHeader('name', 'Name')}
                          {sortHeader('kind', 'Kind')}
                          {sortHeader('status', 'Status')}
                          <th>Used for</th>
                          {sortHeader('updatedAt', 'Updated')}
                          {sortHeader('lastUsedAt', 'Last used')}
                          <th aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map(r => (
                          <tr
                            key={r.name}
                            className={selected?.name === r.name ? 'active' : ''}
                            onClick={() => openView(r)}
                          >
                            <td><NameCell row={r} /></td>
                            <td className="cell-muted">{KIND_LABEL[r.kind]}</td>
                            <td><StatusPill row={r} /></td>
                            <td><UsedFor row={r} sameSite={hints.get(r.name)} /></td>
                            <td className={`secrets-nowrap ${r.updatedAt ? 'cell-mono' : 'cell-muted'}`}>{shortDate(r.updatedAt, now)}</td>
                            <td className={`secrets-nowrap ${r.lastUsedAt && !r.readAtStartup ? 'cell-mono' : 'cell-muted'}`}>{lastUsedText(r, now)}</td>
                            <td>
                              <div className="cell-actions" onClick={e => e.stopPropagation()}>
                                {/* Platform keys belong to the deployment: no edit affordance. */}
                                {r.kind !== 'platform' && (
                                  <button className="btn-icon" title="Edit" aria-label={`Edit ${r.name}`} onClick={() => openEdit(r)}>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                                    </svg>
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                        {rows === null && (
                          <tr><td colSpan={7} className="secrets-empty">Loading…</td></tr>
                        )}
                        {rows !== null && visible.length === 0 && (
                          <tr><td colSpan={7} className="secrets-empty">No secrets match.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {drawerMode === 'view' && selected && (
                  <SecretViewDrawer
                    key={`view-${selected.name}`}
                    row={selected}
                    onClose={closeDrawer}
                    onEdit={() => setDrawerMode('edit')}
                    onRemoved={handleChanged}
                  />
                )}
                {drawerMode === 'edit' && selected && (
                  <SecretEditDrawer
                    key={`edit-${selected.name}`}
                    row={selected}
                    onClose={closeDrawer}
                    onSaved={() => void handleEdited(selected.name)}
                  />
                )}
                {drawerMode === 'create' && (
                  <SecretCreateDrawer existingRows={all} onClose={closeDrawer} onSaved={handleChanged} />
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}

export default SecretsPage;
