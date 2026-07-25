export interface ConfigHistoryEntry {
  id: number | string;
  version?: number;
  changedBy: string;
  note?: string | null;
  reason?: string | null;
  createdAt: string;
  summary?: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

interface ConfigHistoryProps {
  entries: ConfigHistoryEntry[];
  loading?: boolean;
  error?: string | null;
  emptyLabel?: string;
  /** Show at most this many (identity/executive return full history). */
  limit?: number;
}

/** Version history list matching the autonomy settings pattern. */
export function ConfigHistory({
  entries,
  loading = false,
  error = null,
  emptyLabel = 'No changes yet.',
  limit = 10,
}: ConfigHistoryProps) {
  const shown = entries.slice(0, limit);
  return (
    <div className="autonomy-history">
      <div className="autonomy-history-label">Recent Changes</div>
      <div className="autonomy-history-list">
        {shown.length === 0 && !loading && !error && (
          <p className="settings-muted-hint">{emptyLabel}</p>
        )}
        {shown.map(entry => {
          const note = entry.note ?? entry.reason ?? null;
          return (
            <div key={String(entry.id)} className="autonomy-history-entry">
              <div className="autonomy-history-score">
                {entry.version != null ? `v${entry.version}` : 'Change'}
                {entry.summary && (
                  <span className="settings-history-summary">{entry.summary}</span>
                )}
              </div>
              <div className="autonomy-history-meta">
                {entry.changedBy} &middot; {timeAgo(entry.createdAt)}
              </div>
              {note && <div className="autonomy-history-reason">{note}</div>}
            </div>
          );
        })}
        {error && <p className="autonomy-error">{error}</p>}
        {loading && <p className="settings-muted-hint">Loading…</p>}
      </div>
    </div>
  );
}

interface ChangeNoteFieldProps {
  id: string;
  value: string;
  onChange: (v: string) => void;
}

export function ChangeNoteField({ id, value, onChange }: ChangeNoteFieldProps) {
  return (
    <div>
      <label className="autonomy-reason-label" htmlFor={id}>
        Change note (optional)
      </label>
      <textarea
        id={id}
        rows={2}
        placeholder="Reason for change (optional)"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  );
}

/** Safe error message extraction — guards against non-JSON error bodies. */
export async function errorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string };
      if (d.error) return d.error;
    } catch (err) {
      console.error('[errorMessage] failed to read JSON error body:', err);
    }
  }
  return `HTTP ${res.status}`;
}
