import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar, TopbarSearch, TopbarDivider } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type JobStatus = 'pending' | 'running' | 'suspended' | 'paused' | 'completed' | 'cancelled' | 'failed';
type LastRunOutcome = 'completed' | 'failed' | 'timed_out' | null;

interface Job {
  id: string;
  agentId: string;
  cronExpr: string | null;
  runAt: string | null;
  taskPayload: Record<string, unknown>;
  status: JobStatus;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdBy: string;
  createdAt: string;
  timezone: string;
  agentTaskId: string | null;
  intentAnchor: string | null;
  progress: Record<string, unknown> | null;
  runStartedAt: string | null;
  expectedDurationSeconds: number | null;
  lastRunOutcome: LastRunOutcome;
  lastRunSummary: string | null;
  lastRunContext: Record<string, unknown> | null;
  originator: Record<string, unknown> | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ');
}

function formatSchedule(job: Job): string {
  if (job.cronExpr) return job.cronExpr;
  if (job.runAt) return formatDate(job.runAt);
  return '—';
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

// ── Pagination ────────────────────────────────────────────────────────────────

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
  job: Job | null;
  creating: boolean;
  onClose: () => void;
  onSaved: (job: Job) => void;
  onDeleted: (id: string) => void;
}

function JobEditDrawer({ job, creating, onClose, onSaved, onDeleted }: DrawerProps) {
  const isCronJob = job ? job.cronExpr !== null : true;

  const [agentId, setAgentId] = useState(job?.agentId ?? '');
  const [cronExpr, setCronExpr] = useState(job?.cronExpr ?? '');
  const [runAt, setRunAt] = useState(job?.runAt?.slice(0, 16) ?? '');
  const [scheduleType, setScheduleType] = useState<'cron' | 'run_at'>(isCronJob ? 'cron' : 'run_at');
  const [taskPayload, setTaskPayload] = useState(
    job ? JSON.stringify(job.taskPayload, null, 2) : '{\n  \n}',
  );
  const [intentAnchor, setIntentAnchor] = useState(job?.intentAnchor ?? '');
  const [timezone, setTimezone] = useState(job?.timezone === 'UTC' ? '' : (job?.timezone ?? ''));

  const [saving, setSaving] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canResume = job?.status === 'suspended' || job?.status === 'paused';

  async function handleSave() {
    // Validate task_payload JSON before sending.
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(taskPayload) as Record<string, unknown>;
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        setError('Task payload must be a JSON object, not an array or primitive.');
        return;
      }
    } catch {
      setError('Task payload is not valid JSON.');
      return;
    }

    if (creating && !agentId.trim()) {
      setError('Agent ID is required.');
      return;
    }
    if (creating && scheduleType === 'cron' && !cronExpr.trim()) {
      setError('Cron expression is required.');
      return;
    }
    if (creating && scheduleType === 'run_at' && !runAt.trim()) {
      setError('Run-at datetime is required.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      let res: Response;
      if (creating) {
        const body: Record<string, unknown> = {
          agent_id: agentId.trim(),
          task_payload: parsed,
        };
        if (scheduleType === 'cron') {
          body['cron_expr'] = cronExpr.trim();
        } else {
          body['run_at'] = new Date(runAt).toISOString();
        }
        if (intentAnchor.trim()) body['intent_anchor'] = intentAnchor.trim();
        if (timezone.trim()) body['timezone'] = timezone.trim();

        res = await apiFetch('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        const body: Record<string, unknown> = { task_payload: parsed };
        // Only send the schedule field for the type this job uses.
        if (isCronJob) {
          body['cron_expr'] = cronExpr.trim() || job!.cronExpr;
        } else {
          body['run_at'] = runAt.trim()
            ? new Date(runAt).toISOString()
            : job!.runAt;
        }
        res = await apiFetch(`/api/jobs/${job!.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      if (!res.ok) throw new Error(await errorMessage(res));

      const data = await res.json() as { job: Job };
      onSaved(data.job);
    } catch (err) {
      console.error('[JobEditDrawer] save failed:', err);
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleResume() {
    if (!job) return;
    setResuming(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'pending' }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { job: Job };
      onSaved(data.job);
    } catch (err) {
      console.error('[JobEditDrawer] resume failed:', err);
      setError(err instanceof Error ? err.message : 'Resume failed');
    } finally {
      setResuming(false);
    }
  }

  async function handleDelete() {
    if (!job) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorMessage(res));
      onDeleted(job.id);
    } catch (err) {
      console.error('[JobEditDrawer] delete failed:', err);
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div className="drawer-header-top">
          <span className="badge badge-organization">job</span>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <h2 className="drawer-title-h2">{creating ? 'New job' : (job?.agentId ?? '')}</h2>
        {!creating && job && (
          <div className="drawer-subtitle">
            <span className={`status-pill ${job.status}`}>{job.status}</span>
          </div>
        )}
      </div>

      <div className="drawer-body">
        <div className="edit-drawer-form">
          {error && <p style={{ color: 'var(--app-destructive)', margin: 0, fontSize: 13 }}>{error}</p>}

          {creating ? (
            <>
              <div className="form-field">
                <label htmlFor="jf-agent">Agent ID</label>
                <input id="jf-agent" type="text" value={agentId} onChange={e => setAgentId(e.target.value)} placeholder="coordinator" />
              </div>

              <div className="form-field">
                <label>Schedule type</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="radio" name="scheduleType" value="cron" checked={scheduleType === 'cron'} onChange={() => setScheduleType('cron')} />
                    Cron
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="radio" name="scheduleType" value="run_at" checked={scheduleType === 'run_at'} onChange={() => setScheduleType('run_at')} />
                    One-time
                  </label>
                </div>
              </div>

              {scheduleType === 'cron' ? (
                <div className="form-field">
                  <label htmlFor="jf-cron">Cron expression</label>
                  <input id="jf-cron" type="text" value={cronExpr} onChange={e => setCronExpr(e.target.value)} placeholder="0 9 * * 1-5" />
                </div>
              ) : (
                <div className="form-field">
                  <label htmlFor="jf-run-at">Run at</label>
                  <input id="jf-run-at" type="datetime-local" value={runAt} onChange={e => setRunAt(e.target.value)} />
                </div>
              )}

              <div className="form-grid">
                <div className="form-field">
                  <label htmlFor="jf-tz">Timezone</label>
                  <input id="jf-tz" type="text" value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="UTC" />
                </div>
                <div className="form-field">
                  <label htmlFor="jf-anchor">Intent anchor</label>
                  <input id="jf-anchor" type="text" value={intentAnchor} onChange={e => setIntentAnchor(e.target.value)} placeholder="optional" />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="form-grid">
                <div className="form-field">
                  <label>Agent ID</label>
                  <div className="form-field-readonly">{job?.agentId}</div>
                </div>
                <div className="form-field">
                  <label>Timezone</label>
                  <div className="form-field-readonly">{job?.timezone ?? 'UTC'}</div>
                </div>
              </div>

              {isCronJob ? (
                <div className="form-field">
                  <label htmlFor="jf-cron">Cron expression</label>
                  <input id="jf-cron" type="text" value={cronExpr} onChange={e => setCronExpr(e.target.value)} />
                </div>
              ) : (
                <div className="form-field">
                  <label htmlFor="jf-run-at">Run at</label>
                  <input id="jf-run-at" type="datetime-local" value={runAt} onChange={e => setRunAt(e.target.value)} />
                </div>
              )}

              {job?.lastRunAt && (
                <div className="form-grid">
                  <div className="form-field">
                    <label>Last run</label>
                    <div className="form-field-readonly cell-mono">{formatDate(job.lastRunAt)}</div>
                  </div>
                  <div className="form-field">
                    <label>Outcome</label>
                    <div className="form-field-readonly">{job.lastRunOutcome ?? '—'}</div>
                  </div>
                </div>
              )}

              {job?.lastError && (
                <div className="form-field">
                  <label>Last error</label>
                  <div className="form-field-readonly" style={{ color: 'var(--app-destructive)', fontSize: 12, wordBreak: 'break-word' }}>
                    {job.lastError}
                  </div>
                </div>
              )}
            </>
          )}

          <div className="form-field">
            <label htmlFor="jf-payload">Task payload (JSON)</label>
            <textarea
              id="jf-payload"
              rows={8}
              value={taskPayload}
              onChange={e => setTaskPayload(e.target.value)}
              style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
            />
          </div>
        </div>
      </div>

      <div className="drawer-footer">
        {!creating && (
          <button
            className="btn btn-danger btn-sm"
            onClick={() => void handleDelete()}
            disabled={deleting || job?.status === 'cancelled'}
            title={job?.status === 'cancelled' ? 'Job is already cancelled' : undefined}
          >
            {deleting ? 'Cancelling…' : 'Cancel job'}
          </button>
        )}
        <div style={{ flex: 1 }} />
        {canResume && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void handleResume()}
            disabled={resuming}
          >
            {resuming ? 'Resuming…' : 'Resume'}
          </button>
        )}
        <button className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? 'Saving…' : creating ? 'Create' : 'Save changes'}
        </button>
      </div>
    </aside>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | JobStatus;

const ALL_STATUSES: JobStatus[] = ['pending', 'running', 'suspended', 'paused', 'completed', 'cancelled', 'failed'];

export default function JobsPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<{ key: keyof Job; dir: 'asc' | 'desc' }>({ key: 'createdAt', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [editing, setEditing] = useState<Job | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  const load = useCallback(async () => {
    // Clear stale state before each fetch so error and data cannot coexist.
    setLoadError(null);
    setJobs([]);
    try {
      const res = await apiFetch('/api/jobs');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { jobs: Job[] };
      setJobs(data.jobs);
    } catch (err) {
      console.error('[JobsPage] failed to load jobs:', err);
      setLoadError(err instanceof Error ? err.message : 'Failed to load jobs');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function handleNavigate(view: string) {
    const routes: Record<string, string> = {
      contacts:  '/contacts',
      jobs:      '/jobs',
      kg:        '/',
      chat:      '/chat',
      tasks:     '/',
      autonomy:  '/settings/autonomy',
      settings:  '/settings/autonomy',
      wizard:    '/setup',
    };
    const to = routes[view];
    if (to) {
      navigate({ to }).catch(err => {
        console.error(`[JobsPage] navigation to ${to} failed:`, err);
      });
    }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: jobs.length };
    for (const s of ALL_STATUSES) {
      c[s] = jobs.filter(j => j.status === s).length;
    }
    return c;
  }, [jobs]);

  const filtered = useMemo(() => {
    let rows = jobs;
    if (statusFilter !== 'all') rows = rows.filter(j => j.status === statusFilter);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(j =>
        j.agentId.toLowerCase().includes(q) ||
        (j.cronExpr ?? '').toLowerCase().includes(q) ||
        (j.intentAnchor ?? '').toLowerCase().includes(q),
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
  }, [jobs, statusFilter, search, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function toggleSort(key: keyof Job) {
    setSort(s => s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' });
  }
  const sortArrow = (key: keyof Job) => sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '';
  const ariaSortFor = (key: keyof Job): 'ascending' | 'descending' | 'none' =>
    sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';

  function handleSaved(job: Job) {
    setJobs(prev => {
      const idx = prev.findIndex(j => j.id === job.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = job;
        return next;
      }
      return [...prev, job];
    });
    setEditing(job);
    setCreating(false);
  }

  function handleDeleted(id: string) {
    setJobs(prev => prev.filter(j => j.id !== id));
    setEditing(null);
    setCreating(false);
  }

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="jobs" onNavigate={handleNavigate} theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}
        <main className="main">
          <Topbar crumb="Memory" title="Scheduled Jobs">
            <TopbarSearch
              placeholder="Search agent, cron, anchor…"
              value={search}
              onChange={v => { setSearch(v); setPage(1); }}
            />
            <TopbarDivider />
            <button
              className="btn btn-primary btn-sm"
              onClick={() => { setEditing(null); setCreating(true); }}
            >
              + New job
            </button>
          </Topbar>

          {loadError ? (
            <div style={{ padding: 32, color: 'var(--app-destructive)', fontSize: 13 }}>{loadError}</div>
          ) : (
            <>
              {/* Mobile search — TopbarSearch is hidden below 768px by the shared stylesheet */}
              <div className="jobs-mobile-search">
                <input
                  type="text"
                  placeholder="Search agent, cron, anchor…"
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(1); }}
                />
              </div>

              <div className="records-toolbar">
                <div className="records-toolbar-left">
                  <button
                    className={`records-filter-chip${statusFilter === 'all' ? ' active' : ''}`}
                    onClick={() => { setStatusFilter('all'); setPage(1); }}
                  >
                    All
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, opacity: 0.7 }}>
                      {counts['all']}
                    </span>
                  </button>
                  {ALL_STATUSES.map(s => (
                    <button
                      key={s}
                      className={`records-filter-chip${statusFilter === s ? ' active' : ''}`}
                      onClick={() => { setStatusFilter(s); setPage(1); }}
                    >
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, opacity: 0.7 }}>
                        {counts[s]}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="records-toolbar-right">
                  <span className="topbar-meta">{filtered.length} of {jobs.length}</span>
                </div>
              </div>

              <div className="records-layout">
                <div className="records-main">
                  <div className="records-table-wrap">
                    <table className="records-table">
                      <thead>
                        <tr>
                          <th className="sortable" aria-sort={ariaSortFor('agentId')}>
                            <button className="sort-btn" onClick={() => toggleSort('agentId')}>
                              Agent <span className="sort-arrow">{sortArrow('agentId')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={ariaSortFor('status')}>
                            <button className="sort-btn" onClick={() => toggleSort('status')}>
                              Status <span className="sort-arrow">{sortArrow('status')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={ariaSortFor('cronExpr')}>
                            <button className="sort-btn" onClick={() => toggleSort('cronExpr')}>
                              Schedule <span className="sort-arrow">{sortArrow('cronExpr')}</span>
                            </button>
                          </th>
                          <th className="sortable col-updated" aria-sort={ariaSortFor('nextRunAt')}>
                            <button className="sort-btn" onClick={() => toggleSort('nextRunAt')}>
                              Next run <span className="sort-arrow">{sortArrow('nextRunAt')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={ariaSortFor('lastRunOutcome')}>
                            <button className="sort-btn" onClick={() => toggleSort('lastRunOutcome')}>
                              Last outcome <span className="sort-arrow">{sortArrow('lastRunOutcome')}</span>
                            </button>
                          </th>
                          <th className="sortable col-updated" aria-sort={ariaSortFor('createdAt')}>
                            <button className="sort-btn" onClick={() => toggleSort('createdAt')}>
                              Created <span className="sort-arrow">{sortArrow('createdAt')}</span>
                            </button>
                          </th>
                          <th style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map(j => (
                          <tr
                            key={j.id}
                            className={editing?.id === j.id ? 'active' : ''}
                            onClick={() => { setCreating(false); setEditing(j); }}
                          >
                            <td>
                              <span className="cell-primary">{j.agentId}</span>
                            </td>
                            <td>
                              <span className={`status-pill ${j.status}`}>{j.status}</span>
                            </td>
                            <td className="cell-mono">{formatSchedule(j)}</td>
                            <td className="cell-mono col-updated">{formatDate(j.nextRunAt)}</td>
                            <td>{j.lastRunOutcome ?? <span className="cell-muted">—</span>}</td>
                            <td className="cell-mono col-updated">{formatDate(j.createdAt)}</td>
                            <td>
                              <div className="cell-actions" onClick={e => e.stopPropagation()}>
                                <button
                                  className="btn-icon"
                                  title="Edit"
                                  onClick={() => { setCreating(false); setEditing(j); }}
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
                            <td colSpan={7} style={{ textAlign: 'center', padding: 40, color: 'var(--app-fg-muted)' }}>
                              No jobs match.
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
                  <JobEditDrawer
                    key={editing?.id ?? 'new'}
                    job={editing}
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
