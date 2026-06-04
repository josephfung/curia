import { useState, useEffect, useMemo, useCallback } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar, TopbarSearch, TopbarDivider } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type TaskStatus =
  // Task-lifecycle values (migration 049)
  | 'open' | 'in_progress' | 'blocked' | 'waiting' | 'done' | 'cancelled'
  // Legacy scheduler values retained for existing rows
  | 'active' | 'pending' | 'paused' | 'completed' | 'failed';

type TaskOwner = 'curia' | 'ceo' | 'external';
type TaskSource = 'ceo' | 'agent' | 'scheduler' | 'coordinator';

interface Task {
  id: string;
  agentId: string;
  title: string;
  intentAnchor: string;
  description: string | null;
  status: TaskStatus;
  owner: TaskOwner;
  priority: number;
  dueAt: string | null;
  source: TaskSource;
  sourceAgentId: string | null;
  tags: string[];
  waitingOnContactId: string | null;
  waitingOnContactName: string | null;
  waitingOnText: string | null;
  parentTaskId: string | null;
  blockedByTaskId: string | null;
  nextWakeAt: string | null;
  progress: Record<string, unknown>;
  errorBudget: Record<string, unknown>;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ');
}

// Format a timestamp for wake-time display, including the user's local timezone abbreviation.
function formatWakeAt(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

// Returns a compact "age" string (e.g. "2d", "3h", "just now") from an ISO timestamp.
function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms < 86_400_000 * 30) return `${Math.floor(ms / 86_400_000)}d`;
  return `${Math.floor(ms / (86_400_000 * 30))}mo`;
}

function prettyJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

function parseJsonField(raw: string, fieldLabel: string): Record<string, unknown> {
  const v = raw.trim();
  if (!v) return {};
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    throw new Error(`${fieldLabel} must be valid JSON.`);
  }
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
  task: Task | null;
  creating: boolean;
  onClose: () => void;
  onSaved: (task: Task) => void;
  onDeleted: (id: string) => void;
  /** Resolve a task ID to a summary for display in related-task links. */
  lookupTask: (id: string) => { id: string; title: string } | undefined;
  /** Navigate the drawer to a related task by ID. */
  onNavigateTo: (id: string) => void;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'cancelled']);

// Valid task-lifecycle statuses that can be set via the UI.
const EDITABLE_STATUSES: TaskStatus[] = ['open', 'in_progress', 'blocked', 'waiting', 'done', 'cancelled'];

// Legacy scheduler statuses — only readable for old rows, not selectable as new destinations.
const LEGACY_STATUSES = new Set<TaskStatus>(['active', 'pending', 'paused', 'completed', 'failed']);

function TaskEditDrawer({ task, creating, onClose, onSaved, onDeleted, lookupTask, onNavigateTo }: DrawerProps) {
  const [agentId, setAgentId] = useState(task?.agentId ?? '');
  const [title, setTitle] = useState(task?.title ?? '');
  const [intentAnchor, setIntentAnchor] = useState(task?.intentAnchor ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'open');
  const [owner, setOwner] = useState<TaskOwner>(task?.owner ?? 'curia');
  const [priority, setPriority] = useState(String(task?.priority ?? 50));
  const [dueAt, setDueAt] = useState(task?.dueAt ? task.dueAt.slice(0, 10) : '');
  const [source, setSource] = useState<TaskSource>(task?.source ?? 'agent');
  const [tags, setTags] = useState((task?.tags ?? []).join(', '));
  const [conversationId, setConversationId] = useState(task?.conversationId ?? '');
  const [waitingOnText, setWaitingOnText] = useState(task?.waitingOnText ?? '');
  const [errorBudget, setErrorBudget] = useState(prettyJson(task?.errorBudget ?? {}));
  const [progress, setProgress] = useState(prettyJson(task?.progress ?? {}));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whether the current task is in a terminal state (done/cancelled).
  const isTerminal = !creating && task !== null && TERMINAL_STATUSES.has(task.status);

  async function handleSave() {
    if (!agentId.trim()) { setError('Agent ID is required.'); return; }
    if (!intentAnchor.trim()) { setError('Intent anchor is required.'); return; }

    const parsedPriority = parseInt(priority, 10);
    if (isNaN(parsedPriority) || parsedPriority < 0 || parsedPriority > 100) {
      setError('Priority must be an integer 0–100.');
      return;
    }

    // Block invalid status transitions for terminal tasks — mirrored from TaskRepo.
    if (isTerminal && status !== task!.status) {
      setError(`Cannot change status from '${task!.status}' — that status is final.`);
      return;
    }

    let parsedErrorBudget: Record<string, unknown>;
    let parsedProgress: Record<string, unknown>;
    try {
      parsedErrorBudget = parseJsonField(errorBudget, 'Error budget');
      parsedProgress = parseJsonField(progress, 'Progress');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const parsedTags = tags.split(',').map(t => t.trim()).filter(Boolean);
      const body = {
        agentId: agentId.trim(),
        title: title.trim() || intentAnchor.trim(),
        intentAnchor: intentAnchor.trim(),
        description: description.trim() || null,
        status,
        owner,
        priority: parsedPriority,
        dueAt: dueAt || null,
        source,
        tags: parsedTags,
        conversationId: conversationId.trim() || null,
        waitingOnText: waitingOnText.trim() || null,
        errorBudget: parsedErrorBudget,
        progress: parsedProgress,
      };

      let res: Response;
      if (creating) {
        res = await apiFetch('/api/kg/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        res = await apiFetch(`/api/kg/tasks/${task!.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { task: Task };
      onSaved(data.task);
    } catch (err) {
      console.error('[TaskEditDrawer] save failed:', err);
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!task) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/kg/tasks/${task.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorMessage(res));
      onDeleted(task.id);
    } catch (err) {
      console.error('[TaskEditDrawer] delete failed:', err);
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  // Render a related-task link: shows the task title and navigates the drawer on click.
  // If the task isn't in the loaded list (e.g. filtered out or outside LIMIT 500),
  // renders a read-only UUID field instead of a dead-click button.
  function relatedTaskLink(label: string, id: string | null) {
    if (!id) return null;
    const related = lookupTask(id);
    if (!related) {
      return (
        <div className="form-field">
          <label>{label}</label>
          <div className="form-field-readonly cell-mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{id}</div>
        </div>
      );
    }
    return (
      <div className="form-field">
        <label>{label}</label>
        <button
          type="button"
          className="task-related-link"
          onClick={() => onNavigateTo(id)}
          title={id}
        >
          {related.title}
        </button>
      </div>
    );
  }

  // Render a read-only UUID field (for system-managed FKs with no link behaviour).
  function uuidField(label: string, value: string | null) {
    if (!value) return null;
    return (
      <div className="form-field">
        <label>{label}</label>
        <div className="form-field-readonly cell-mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{value}</div>
      </div>
    );
  }

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div className="drawer-header-top">
          <span className="badge badge-task">task</span>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <h2 className="drawer-title-h2">{creating ? 'New task' : (task?.title || task?.agentId) ?? ''}</h2>
        {!creating && task && (
          <div className="drawer-subtitle">
            <span className={`status-pill ${task.status}`}>{task.status.replace('_', ' ')}</span>
            {task.nextWakeAt && (
              <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--app-fg-muted)' }}>
                wakes {formatWakeAt(task.nextWakeAt)}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="drawer-body">
        <div className="edit-drawer-form">
          {error && <p style={{ color: 'var(--app-destructive)', margin: 0, fontSize: 13 }}>{error}</p>}

          {isTerminal && (
            <p style={{ color: 'var(--app-fg-muted)', margin: 0, fontSize: 12, fontStyle: 'italic' }}>
              This task is in a terminal state. Status cannot be changed.
            </p>
          )}

          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="tf-agent-id">Agent ID</label>
              <input id="tf-agent-id" type="text" value={agentId} onChange={e => setAgentId(e.target.value)} placeholder="e.g. coordinator" />
            </div>
            <div className="form-field">
              <label htmlFor="tf-status">Status</label>
              <select
                id="tf-status"
                value={status}
                onChange={e => setStatus(e.target.value as TaskStatus)}
                disabled={isTerminal}
              >
                {/* If the current value is a legacy status, show it as a read-only stub so
                    old rows remain readable, but don't include it in the selectable list. */}
                {LEGACY_STATUSES.has(status) && (
                  <option value={status} disabled>{status} (legacy)</option>
                )}
                {EDITABLE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="tf-owner">Owner</label>
              <select id="tf-owner" value={owner} onChange={e => setOwner(e.target.value as TaskOwner)}>
                <option value="curia">curia</option>
                <option value="ceo">ceo</option>
                <option value="external">external</option>
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="tf-priority">Priority (0–100)</label>
              <input id="tf-priority" type="number" min="0" max="100" value={priority} onChange={e => setPriority(e.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="tf-due-at">Due date</label>
              <input id="tf-due-at" type="date" value={dueAt} onChange={e => setDueAt(e.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="tf-source">Source</label>
              <select id="tf-source" value={source} onChange={e => setSource(e.target.value as TaskSource)}>
                <option value="agent">agent</option>
                <option value="ceo">ceo</option>
                <option value="scheduler">scheduler</option>
                <option value="coordinator">coordinator</option>
              </select>
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="tf-title">Title</label>
            <input id="tf-title" type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Short task title" />
          </div>
          <div className="form-field">
            <label htmlFor="tf-description">Description</label>
            <textarea id="tf-description" rows={2} value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional longer description…" />
          </div>
          <div className="form-field">
            <label htmlFor="tf-intent">Intent anchor</label>
            <textarea id="tf-intent" rows={3} value={intentAnchor} onChange={e => setIntentAnchor(e.target.value)} placeholder="Persistent task goal/context…" />
          </div>
          <div className="form-field">
            <label htmlFor="tf-tags">Tags (comma-separated)</label>
            <input id="tf-tags" type="text" value={tags} onChange={e => setTags(e.target.value)} placeholder="e.g. follow-up, finance" />
          </div>
          <div className="form-field">
            <label htmlFor="tf-waiting-text">Waiting on (text)</label>
            <textarea id="tf-waiting-text" rows={2} value={waitingOnText} onChange={e => setWaitingOnText(e.target.value)} placeholder="Who or what are we waiting on?" />
          </div>
          <div className="form-field">
            <label htmlFor="tf-conv-id">Conversation ID (UUID)</label>
            <input id="tf-conv-id" type="text" value={conversationId} onChange={e => setConversationId(e.target.value)} placeholder="UUID — optional" />
          </div>

          {/* Read-only system-managed fields */}
          {!creating && (
            <>
              {task?.waitingOnContactId && (
                <div className="form-field">
                  <label>Waiting on contact</label>
                  <div className="form-field-readonly">
                    {task.waitingOnContactName ?? task.waitingOnContactId}
                  </div>
                </div>
              )}
              {relatedTaskLink('Parent task', task?.parentTaskId ?? null)}
              {relatedTaskLink('Blocked by', task?.blockedByTaskId ?? null)}
              {uuidField('Source agent ID', task?.sourceAgentId ?? null)}
            </>
          )}

          <div className="form-field">
            <label htmlFor="tf-budget">Error budget JSON</label>
            <textarea id="tf-budget" rows={4} value={errorBudget} onChange={e => setErrorBudget(e.target.value)} placeholder='{"maxTurns": 12, "maxConsecutiveErrors": 3}' style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }} />
          </div>
          <div className="form-field">
            <label htmlFor="tf-progress">Progress JSON</label>
            <textarea id="tf-progress" rows={4} value={progress} onChange={e => setProgress(e.target.value)} placeholder='{"phase": "initializing"}' style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }} />
          </div>
        </div>
      </div>

      <div className="drawer-footer">
        {!creating && (
          <button
            className="btn btn-danger btn-sm"
            onClick={() => void handleDelete()}
            disabled={deleting}
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

type SortKey = 'title' | 'agentId' | 'owner' | 'priority' | 'status' | 'dueAt' | 'updatedAt' | 'createdAt';

const STATUS_FILTERS = [
  'all',
  // Primary task-lifecycle values
  'open', 'in_progress', 'blocked', 'waiting', 'done', 'cancelled',
  // Legacy scheduler values
  'active', 'pending', 'paused', 'completed', 'failed',
] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

type OwnerFilter = 'all' | TaskOwner;

export default function TasksPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all');
  // Default sort: priority DESC; due_at ASC is the tiebreaker in the sort comparator.
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'priority', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [editing, setEditing] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await apiFetch('/api/kg/tasks');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { tasks: Task[] };
      setTasks(data.tasks);
    } catch (err) {
      console.error('[TasksPage] failed to load tasks:', err);
      setLoadError(err instanceof Error ? err.message : 'Failed to load tasks');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: tasks.length };
    for (const s of STATUS_FILTERS.slice(1)) c[s] = 0;
    for (const t of tasks) {
      const cur = c[t.status];
      if (cur !== undefined) c[t.status] = cur + 1;
    }
    return c;
  }, [tasks]);

  const filtered = useMemo(() => {
    let rows = tasks;
    if (statusFilter !== 'all') rows = rows.filter(t => t.status === statusFilter);
    if (ownerFilter !== 'all') rows = rows.filter(t => t.owner === ownerFilter);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(t =>
        (t.title + ' ' + t.agentId + ' ' + t.intentAnchor + ' ' + t.tags.join(' ')).toLowerCase().includes(q)
      );
    }
    const dir = sort.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const av = (a[sort.key] ?? '') as string | number;
      const bv = (b[sort.key] ?? '') as string | number;
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      // Secondary tiebreaker when sorting by priority: due_at ASC NULLS LAST,
      // mirroring the tasks_open_priority_idx sort order from the DB.
      if (sort.key === 'priority') {
        const da = a.dueAt ?? '￿';
        const db = b.dueAt ?? '￿';
        if (da < db) return -1;
        if (da > db) return 1;
      }
      return 0;
    });
    return rows;
  }, [tasks, statusFilter, ownerFilter, search, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function toggleSort(key: SortKey) {
    setSort(s => s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'priority' ? 'desc' : 'asc' });
  }
  const sortArrow = (key: SortKey) => sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '';
  const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' =>
    sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';

  function handleSaved(task: Task) {
    setTasks(prev => {
      const idx = prev.findIndex(t => t.id === task.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = task;
        return next;
      }
      setStatusFilter('all');
      return [...prev, task];
    });
    setEditing(task);
    setCreating(false);
  }

  function handleDeleted(id: string) {
    setTasks(prev => prev.filter(t => t.id !== id));
    setEditing(null);
    setCreating(false);
  }

  /** Resolve a task ID to a lightweight summary for the drawer's related-task links. */
  function lookupTask(id: string): { id: string; title: string } | undefined {
    const t = tasks.find(t => t.id === id);
    return t ? { id: t.id, title: t.title || t.intentAnchor } : undefined;
  }

  /** Navigate the drawer to a different task (parent, blocked-by). */
  function handleNavigateTo(id: string) {
    const target = tasks.find(t => t.id === id);
    if (target) {
      setCreating(false);
      setEditing(target);
    }
  }

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="tasks" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}
        <main className="main tasks-page">
          <Topbar crumb="Memory" title="Tasks">
            <TopbarSearch
              placeholder="Search title, agent, tags…"
              value={search}
              onChange={v => { setSearch(v); setPage(1); }}
            />
            <TopbarDivider />
            <button
              className="btn btn-primary btn-sm"
              onClick={() => { setEditing(null); setCreating(true); }}
            >
              + New task
            </button>
          </Topbar>

          {loadError ? (
            <div style={{ padding: 32, color: 'var(--app-destructive)', fontSize: 13 }}>{loadError}</div>
          ) : (
            <>
              {/* Mobile search — TopbarSearch is hidden below 768px by the shared stylesheet */}
              <div className="tasks-mobile-search">
                <input
                  type="text"
                  placeholder="Search title, agent, tags…"
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(1); }}
                />
              </div>

              <div className="records-toolbar">
                <div className="records-toolbar-left">
                  {STATUS_FILTERS.map(v => (
                    <button
                      key={v}
                      className={`records-filter-chip${statusFilter === v ? ' active' : ''}`}
                      onClick={() => { setStatusFilter(v); setPage(1); }}
                    >
                      {v === 'all' ? 'All' : v.replace('_', ' ')}
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, opacity: 0.7 }}>
                        {counts[v] ?? 0}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="records-toolbar-right">
                  {/* Owner filter — compact dropdown keeps the toolbar to one row */}
                  <label htmlFor="tasks-owner-filter" style={{ fontSize: 12, color: 'var(--app-fg-muted)' }}>
                    Owner
                  </label>
                  <select
                    id="tasks-owner-filter"
                    className="records-filter-select"
                    value={ownerFilter}
                    onChange={e => { setOwnerFilter(e.target.value as OwnerFilter); setPage(1); }}
                  >
                    <option value="all">All</option>
                    <option value="curia">curia</option>
                    <option value="ceo">ceo</option>
                    <option value="external">external</option>
                  </select>
                  <span className="topbar-meta">{filtered.length} of {tasks.length}</span>
                </div>
              </div>

              <div className="records-layout">
                <div className="records-main">
                  <div className="records-table-wrap">
                    <table className="records-table">
                      <thead>
                        <tr>
                          <th className="sortable" aria-sort={ariaSort('title')}>
                            <button className="sort-btn" onClick={() => toggleSort('title')}>
                              Title <span className="sort-arrow">{sortArrow('title')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={ariaSort('owner')}>
                            <button className="sort-btn" onClick={() => toggleSort('owner')}>
                              Owner <span className="sort-arrow">{sortArrow('owner')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={ariaSort('status')}>
                            <button className="sort-btn" onClick={() => toggleSort('status')}>
                              Status <span className="sort-arrow">{sortArrow('status')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={ariaSort('priority')}>
                            <button className="sort-btn" onClick={() => toggleSort('priority')}>
                              Pri <span className="sort-arrow">{sortArrow('priority')}</span>
                            </button>
                          </th>
                          <th className="sortable col-updated" aria-sort={ariaSort('dueAt')}>
                            <button className="sort-btn" onClick={() => toggleSort('dueAt')}>
                              Due <span className="sort-arrow">{sortArrow('dueAt')}</span>
                            </button>
                          </th>
                          <th className="col-updated" style={{ color: 'var(--app-fg-muted)', fontSize: 11 }}>Age</th>
                          <th className="sortable col-updated" aria-sort={ariaSort('updatedAt')}>
                            <button className="sort-btn" onClick={() => toggleSort('updatedAt')}>
                              Updated <span className="sort-arrow">{sortArrow('updatedAt')}</span>
                            </button>
                          </th>
                          <th style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map(t => (
                          <tr
                            key={t.id}
                            className={editing?.id === t.id ? 'active' : ''}
                            onClick={() => { setCreating(false); setEditing(t); }}
                          >
                            <td>
                              <span className="cell-primary">{t.title || t.intentAnchor}</span>
                              {t.tags.length > 0 && (
                                <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--app-fg-muted)' }}>
                                  {t.tags.join(', ')}
                                </span>
                              )}
                            </td>
                            <td><span className={`badge badge-${t.owner}`}>{t.owner}</span></td>
                            <td><span className={`status-pill ${t.status}`}>{t.status.replace('_', ' ')}</span></td>
                            <td className="cell-mono" style={{ textAlign: 'center' }}>{t.priority}</td>
                            <td className="cell-mono col-updated">{formatDate(t.dueAt)}</td>
                            <td className="cell-mono col-updated" style={{ color: 'var(--app-fg-muted)' }}>{formatAge(t.createdAt)}</td>
                            <td className="cell-mono col-updated">{formatDateTime(t.updatedAt)}</td>
                            <td>
                              <div className="cell-actions" onClick={e => e.stopPropagation()}>
                                <button
                                  className="btn-icon"
                                  title="Edit"
                                  onClick={() => { setCreating(false); setEditing(t); }}
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
                            <td colSpan={8} style={{ textAlign: 'center', padding: 40, color: 'var(--app-fg-muted)' }}>
                              No tasks match.
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
                  <TaskEditDrawer
                    key={editing ? `${editing.id}-${editing.updatedAt}` : 'new'}
                    task={editing}
                    creating={creating}
                    onClose={() => { setEditing(null); setCreating(false); }}
                    onSaved={handleSaved}
                    onDeleted={handleDeleted}
                    lookupTask={lookupTask}
                    onNavigateTo={handleNavigateTo}
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
