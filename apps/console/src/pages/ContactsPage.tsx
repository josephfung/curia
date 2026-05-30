import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar, TopbarSearch, TopbarDivider } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type ContactStatus = 'confirmed' | 'provisional' | 'blocked';
type TrustLevel = 'ceo' | 'high' | 'medium' | 'low' | null;
type SystemRole = 'principal' | 'agent' | 'system' | null;

interface Contact {
  id: string;
  kgNodeId: string | null;
  displayName: string;
  role: string | null;
  status: ContactStatus;
  notes: string | null;
  trustLevel: TrustLevel;
  systemRole: SystemRole;
  createdAt: string;
  updatedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name.split(' ').map(s => s[0] ?? '').slice(0, 2).join('').toUpperCase();
}

function formatDate(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

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

// ── Pagination component ──────────────────────────────────────────────────────

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

  // @TODO: cap at 7 buttons with ellipsis when totalPages grows large.
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

// ── Edit / Create drawer ──────────────────────────────────────────────────────

interface DrawerProps {
  contact: Contact | null;
  creating: boolean;
  onClose: () => void;
  onSaved: (contact: Contact) => void;
  onDeleted: (id: string) => void;
}

function ContactEditDrawer({ contact, creating, onClose, onSaved, onDeleted }: DrawerProps) {
  const [displayName, setDisplayName] = useState(contact?.displayName ?? '');
  const [role, setRole] = useState(contact?.role ?? '');
  const [status, setStatus] = useState<ContactStatus>(contact?.status ?? 'provisional');
  const [trustLevel, setTrustLevel] = useState<TrustLevel>(contact?.trustLevel ?? null);
  const [kgNodeId, setKgNodeId] = useState(contact?.kgNodeId ?? '');
  const [notes, setNotes] = useState(contact?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!displayName.trim()) {
      setError('Display name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        displayName: displayName.trim(),
        role: role.trim() || null,
        status,
        trustLevel: trustLevel ?? null,
        notes: notes.trim() || null,
        kgNodeId: kgNodeId.trim() || null,
      };

      let res: Response;
      if (creating) {
        res = await apiFetch('/api/kg/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res = await apiFetch(`/api/kg/contacts/${contact!.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      if (!res.ok) {
        throw new Error(await errorMessage(res));
      }

      const data = await res.json() as { contact: Contact };
      onSaved(data.contact);
    } catch (err) {
      console.error('[ContactEditDrawer] save failed:', err);
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!contact) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/kg/contacts/${contact.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorMessage(res));
      onDeleted(contact.id);
    } catch (err) {
      console.error('[ContactEditDrawer] delete failed:', err);
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div className="drawer-header-top">
          <span className="badge badge-person">contact</span>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <h2 className="drawer-title-h2">{creating ? 'New contact' : (contact?.displayName ?? '')}</h2>
        {!creating && contact && (
          <div className="drawer-subtitle">{[contact.role].filter(Boolean).join(' · ')}</div>
        )}
      </div>

      <div className="drawer-body">
        <div className="edit-drawer-form">
          {error && <p style={{ color: 'var(--app-destructive)', margin: 0, fontSize: 13 }}>{error}</p>}

          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="cf-name">Display name</label>
              <input id="cf-name" type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-role">Role</label>
              <input id="cf-role" type="text" value={role} onChange={e => setRole(e.target.value)} placeholder="Title" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-status">Status</label>
              <select id="cf-status" value={status} onChange={e => setStatus(e.target.value as ContactStatus)}>
                <option value="confirmed">Confirmed</option>
                <option value="provisional">Provisional</option>
                <option value="blocked">Blocked</option>
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="cf-trust">Trust level</label>
              <select id="cf-trust" value={trustLevel ?? ''} onChange={e => setTrustLevel((e.target.value || null) as TrustLevel)}>
                <option value="">None</option>
                <option value="ceo">CEO</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="cf-kg">KG node ID</label>
            <input id="cf-kg" type="text" value={kgNodeId} onChange={e => setKgNodeId(e.target.value)} placeholder="UUID — optional" />
          </div>
          <div className="form-field">
            <label htmlFor="cf-notes">Notes</label>
            <textarea id="cf-notes" rows={4} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="drawer-footer">
        {!creating && (
          <button
            className="btn btn-danger btn-sm"
            onClick={() => void handleDelete()}
            disabled={deleting || contact?.systemRole !== null && contact?.systemRole !== undefined}
            title={contact?.systemRole ? 'System contacts cannot be deleted' : undefined}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" onClick={() => void handleSave()} disabled={saving}>
          {saving ? 'Saving…' : creating ? 'Create' : 'Save changes'}
        </button>
      </div>
    </aside>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ContactsPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ContactStatus>('all');
  const [sort, setSort] = useState<{ key: keyof Contact; dir: 'asc' | 'desc' }>({ key: 'updatedAt', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/kg/contacts');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { contacts: Contact[] };
      setContacts(data.contacts);
    } catch (err) {
      console.error('[ContactsPage] failed to load contacts:', err);
      setLoadError(err instanceof Error ? err.message : 'Failed to load contacts');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function handleNavigate(view: string) {
    const routes: Record<string, string> = {
      contacts:  '/contacts',
      kg:        '/kg',
      chat:      '/chat',
      tasks:     '/tasks',
      jobs:      '/jobs',
      autonomy:  '/settings/autonomy',
      settings:  '/settings/autonomy',
      wizard:    '/setup',
    };
    const to = routes[view];
    if (to) {
      navigate({ to }).catch(err => {
        console.error(`[ContactsPage] navigation to ${to} failed:`, err);
      });
    }
  }

  const counts = useMemo(() => ({
    all:         contacts.length,
    confirmed:   contacts.filter(c => c.status === 'confirmed').length,
    provisional: contacts.filter(c => c.status === 'provisional').length,
    blocked:     contacts.filter(c => c.status === 'blocked').length,
  }), [contacts]);

  const filtered = useMemo(() => {
    let rows = contacts;
    if (statusFilter !== 'all') rows = rows.filter(c => c.status === statusFilter);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(c =>
        (c.displayName + ' ' + (c.role ?? '')).toLowerCase().includes(q)
      );
    }
    const dir = sort.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const av = (a[sort.key] ?? '') as string;
      const bv = (b[sort.key] ?? '') as string;
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      return 0;
    });
    return rows;
  }, [contacts, statusFilter, search, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function toggleSort(key: keyof Contact) {
    setSort(s => s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' });
  }
  const sortArrow = (key: keyof Contact) => sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '';

  function handleSaved(contact: Contact) {
    setContacts(prev => {
      const idx = prev.findIndex(c => c.id === contact.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = contact;
        return next;
      }
      return [...prev, contact];
    });
    setEditing(contact);
    setCreating(false);
  }

  function handleDeleted(id: string) {
    setContacts(prev => prev.filter(c => c.id !== id));
    setEditing(null);
    setCreating(false);
  }

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="contacts" onNavigate={handleNavigate} theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}
        <main className="main">
          <Topbar crumb="Memory" title="Contacts">
            <TopbarSearch
              placeholder="Search name or role…"
              value={search}
              onChange={v => { setSearch(v); setPage(1); }}
            />
            <TopbarDivider />
            <button
              className="btn btn-primary btn-sm"
              onClick={() => { setEditing(null); setCreating(true); }}
            >
              + New contact
            </button>
          </Topbar>

          {loadError ? (
            <div style={{ padding: 32, color: 'var(--app-destructive)', fontSize: 13 }}>{loadError}</div>
          ) : (
            <>
              {/* Mobile search — TopbarSearch is hidden below 768px by the shared stylesheet */}
              <div className="contacts-mobile-search">
                <input
                  type="text"
                  placeholder="Search name or role…"
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(1); }}
                />
              </div>

              <div className="records-toolbar">
                <div className="records-toolbar-left">
                  {(['all', 'confirmed', 'provisional', 'blocked'] as const).map(v => (
                    <button
                      key={v}
                      className={`records-filter-chip${statusFilter === v ? ' active' : ''}`}
                      onClick={() => { setStatusFilter(v); setPage(1); }}
                    >
                      {v === 'all' ? 'All' : v.charAt(0).toUpperCase() + v.slice(1)}
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, opacity: 0.7 }}>
                        {counts[v]}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="records-toolbar-right">
                  <span className="topbar-meta">{filtered.length} of {contacts.length}</span>
                </div>
              </div>

              <div className="records-layout">
                <div className="records-main">
                  <div className="records-table-wrap">
                    <table className="records-table">
                      <thead>
                        <tr>
                          <th className="sortable" aria-sort={sort.key === 'displayName' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('displayName')}>
                              Name <span className="sort-arrow">{sortArrow('displayName')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={sort.key === 'role' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('role')}>
                              Role <span className="sort-arrow">{sortArrow('role')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={sort.key === 'status' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('status')}>
                              Status <span className="sort-arrow">{sortArrow('status')}</span>
                            </button>
                          </th>
                          <th className="sortable col-updated" aria-sort={sort.key === 'updatedAt' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('updatedAt')}>
                              Updated <span className="sort-arrow">{sortArrow('updatedAt')}</span>
                            </button>
                          </th>
                          <th style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map(c => (
                          <tr
                            key={c.id}
                            className={editing?.id === c.id ? 'active' : ''}
                            onClick={() => { setCreating(false); setEditing(c); }}
                          >
                            <td>
                              <div className="cell-with-avatar">
                                <span className="avatar-sm">{initials(c.displayName)}</span>
                                <span className="cell-primary">{c.displayName}</span>
                                {c.systemRole === 'principal' && (
                                  <span className="system-role-badge system-role-principal">Principal</span>
                                )}
                                {c.systemRole === 'agent' && (
                                  <span className="system-role-badge system-role-agent">Agent</span>
                                )}
                              </div>
                            </td>
                            <td>{c.role ?? ''}</td>
                            <td><span className={`status-pill ${c.status}`}>{c.status}</span></td>
                            <td className="cell-mono col-updated">{formatDate(c.updatedAt)}</td>
                            <td>
                              <div className="cell-actions" onClick={e => e.stopPropagation()}>
                                <button
                                  className="btn-icon"
                                  title="Edit"
                                  onClick={() => { setCreating(false); setEditing(c); }}
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                                  </svg>
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {pageRows.length === 0 && (
                          <tr>
                            <td colSpan={5} style={{ textAlign: 'center', padding: 40, color: 'var(--app-fg-muted)' }}>
                              No contacts match.
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

                {(editing !== null || creating) && (
                  <ContactEditDrawer
                    key={editing?.id ?? 'new'}
                    contact={editing}
                    creating={creating}
                    onClose={() => { setEditing(null); setCreating(false); }}
                    onSaved={handleSaved}
                    onDeleted={handleDeleted}
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
