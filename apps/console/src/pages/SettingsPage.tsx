import { useState, useEffect, useCallback } from 'react';
import { Link } from '@tanstack/react-router';
import { MobileMenuContext } from '../context/MobileMenu';
import { Sidebar } from '../components/Sidebar';
import { Topbar } from '../components/Topbar';
import { apiFetch } from '../api';
import { useTheme } from '../hooks/useTheme';

// ── Band metadata ─────────────────────────────────────────────────────────────

type AutonomyBand = 'full' | 'spot-check' | 'approval-required' | 'draft-only' | 'restricted';

// Band colors match the legacy UI and the app's design token palette.
const BAND_META: Record<AutonomyBand, { label: string; color: string; description: string }> = {
  'full':              { label: 'Full',              color: '#5E9E6B', description: 'Curia acts independently with no confirmation required for any standard operation.' },
  'spot-check':        { label: 'Spot-check',        color: '#6BAED6', description: 'Curia proceeds with most actions and flags a small random sample for your review.' },
  'approval-required': { label: 'Approval Required', color: '#C9874A', description: 'Curia drafts and plans, then pauses for your explicit approval before acting.' },
  'draft-only':        { label: 'Draft Only',        color: '#7E6BA8', description: 'Curia prepares drafts and summaries but does not send, schedule, or commit anything.' },
  'restricted':        { label: 'Restricted',        color: '#E86040', description: 'Curia operates in read-only mode. No writes, sends, or external actions.' },
};

function bandForScore(score: number): AutonomyBand {
  if (score >= 90) return 'full';
  if (score >= 80) return 'spot-check';
  if (score >= 70) return 'approval-required';
  if (score >= 60) return 'draft-only';
  return 'restricted';
}

function BandBadge({ band }: { band: AutonomyBand }) {
  const meta = BAND_META[band] ?? { label: band, color: '#999' };
  return (
    <span
      className="band-badge"
      style={{
        background: meta.color + '22',
        color: meta.color,
        borderColor: meta.color + '44',
      }}
    >
      {meta.label}
    </span>
  );
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

// ── Types ─────────────────────────────────────────────────────────────────────

interface AutonomyConfig {
  score: number;
  band: AutonomyBand;
  bandDescription: string;
  updatedAt: string;
  updatedBy: string;
}

interface HistoryEntry {
  id: string;
  score: number;
  previousScore: number | null;
  band: AutonomyBand;
  changedBy: string;
  reason: string | null;
  changedAt: string;
}

// Safe error message extraction — guards against non-JSON error bodies (e.g. rate-limiter HTML).
async function errorMessage(res: Response): Promise<string> {
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

// ── Autonomy section ──────────────────────────────────────────────────────────

function AutonomySection() {
  const [config, setConfig] = useState<AutonomyConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Slider live-preview: track score independently so the badge updates as the user drags.
  const [sliderScore, setSliderScore] = useState(75);
  const [savedScore, setSavedScore] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [saving, setSaving] = useState(false);

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Both the badge and description follow the slider live — BAND_META owns the copy.
  const liveBand = bandForScore(sliderScore);
  const liveDescription = BAND_META[liveBand].description;

  const loadHistory = useCallback(async (offset: number) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await apiFetch(`/api/autonomy/history?limit=5&offset=${offset}`);
      if (!res.ok) {
        throw new Error(await errorMessage(res));
      }
      const data = await res.json() as { history: HistoryEntry[]; total: number };
      setHistory(prev => offset === 0 ? data.history : [...prev, ...data.history]);
      setHistoryTotal(data.total);
      setHistoryOffset(offset + data.history.length);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to load history');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/autonomy');
        if (!res.ok) {
          throw new Error(await errorMessage(res));
        }
        const data = await res.json() as { autonomy: AutonomyConfig | null };
        if (!data.autonomy) {
          setLoadError('Autonomy settings have not been initialized on this instance.');
          return;
        }
        setConfig(data.autonomy);
        setSliderScore(data.autonomy.score);
        setSavedScore(data.autonomy.score);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load autonomy settings');
      }
    }
    void load();
    void loadHistory(0);
  }, [loadHistory]);

  async function handleSave() {
    setSaving(true);
    setSaveStatus('Saving…');
    try {
      const res = await apiFetch('/api/autonomy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: sliderScore, reason: reason.trim() || undefined }),
      });
      if (!res.ok) {
        throw new Error(await errorMessage(res));
      }
      const data = await res.json() as {
        autonomy: AutonomyConfig;
        previousScore: number;
      };
      setConfig(data.autonomy);
      setSavedScore(data.autonomy.score);
      setReason('');
      setSaveStatus('Saved');
      setTimeout(() => setSaveStatus(''), 2000);

      // Refetch history from the start so the new entry comes from the server
      // with a real ID — avoids duplicate rows when "Show more" is clicked.
      loadHistory(0).catch(err => {
        console.error('[handleSave] post-save history refresh failed:', err);
      });
    } catch (err) {
      setSaveStatus(`Error: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="settings-page-header">
        <p className="autonomy-error">{loadError}</p>
      </div>
    );
  }

  const isDirty = savedScore !== null && sliderScore !== savedScore;

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">Autonomy</h2>
        <p className="settings-page-sub">
          How far Curia is allowed to act before stopping for your confirmation.
        </p>
      </div>

      {/* Current state */}
      <div style={{ marginBottom: 28 }}>
        <div className="autonomy-current">
          <span className="autonomy-score">{config ? sliderScore : '—'}</span>
          {config && <BandBadge band={liveBand} />}
        </div>
        <p className="autonomy-band-desc">
          {config ? liveDescription : 'Loading…'}
        </p>
      </div>

      {/* Adjust score */}
      {config && (
        <div className="autonomy-control">
          <div className="autonomy-control-label">Adjust Score</div>
          <input
            type="range"
            className="autonomy-slider"
            min={0}
            max={100}
            step={1}
            value={sliderScore}
            onChange={e => setSliderScore(Number(e.target.value))}
          />
          <div className="slider-labels">
            <span>Restricted</span>
            <span>Full</span>
          </div>
          <div>
            <label className="autonomy-reason-label" htmlFor="autonomy-reason">
              Reason (optional)
            </label>
            <textarea
              id="autonomy-reason"
              rows={2}
              placeholder="Reason for change (optional)"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </div>
          <div className="autonomy-save-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!isDirty || saving}
              onClick={() => void handleSave()}
            >
              Save
            </button>
            {saveStatus && <span className="autonomy-save-status">{saveStatus}</span>}
          </div>
        </div>
      )}

      {/* History */}
      <div className="autonomy-history">
        <div className="autonomy-history-label">Recent Changes</div>
        <div className="autonomy-history-list">
          {history.map(entry => {
            const meta = BAND_META[entry.band] ?? { label: entry.band, color: '#999' };
            const scoreText = entry.previousScore !== null
              ? `${entry.previousScore} → ${entry.score}`
              : `— → ${entry.score}`;
            return (
              <div key={entry.id} className="autonomy-history-entry">
                <div className="autonomy-history-score">
                  {scoreText}
                  <span
                    className="band-badge"
                    style={{
                      fontSize: 11,
                      background: meta.color + '22',
                      color: meta.color,
                      borderColor: meta.color + '44',
                    }}
                  >
                    {meta.label}
                  </span>
                </div>
                <div className="autonomy-history-meta">
                  {entry.changedBy} &middot; {timeAgo(entry.changedAt)}
                </div>
                {entry.reason && (
                  <div className="autonomy-history-reason">{entry.reason}</div>
                )}
              </div>
            );
          })}
          {historyError && <p className="autonomy-error">{historyError}</p>}
        </div>
        {historyOffset < historyTotal && (
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: 12 }}
            disabled={historyLoading}
            onClick={() => void loadHistory(historyOffset)}
          >
            {historyLoading ? 'Loading…' : 'Show more'}
          </button>
        )}
      </div>
    </>
  );
}

// ── Settings layout ───────────────────────────────────────────────────────────

// The settings nav sections. Only 'autonomy' is functional; 'workspace' is a stub
// for a future PR. Skills and Agents used to live here but are now standalone
// top-level pages (see RegistrySettings.tsx) reachable from the sidebar directly.
// Rendered as <Link> elements so the URL changes on click and back/forward
// navigation works correctly within the settings shell.
const SETTINGS_SECTIONS = [
  { id: 'autonomy',  label: 'Autonomy',    href: '/settings/autonomy' },
  { id: 'workspace', label: 'Workspace',   href: '/settings/workspace' },
];

interface SettingsLayoutProps {
  activeSection: string;
  children: React.ReactNode;
}

export function SettingsLayout({ activeSection, children }: SettingsLayoutProps) {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="settings" theme={theme} onThemeChange={setTheme} />
        <main className="main">
          <Topbar crumb="Settings" title="Workspace" />
          <div className="settings-shell">
            <nav className="settings-nav">
              <div className="settings-nav-title">Settings</div>
              {SETTINGS_SECTIONS.map(s => (
                <Link
                  key={s.id}
                  to={s.href}
                  className={`settings-nav-item${activeSection === s.id ? ' active' : ''}`}
                >
                  {s.label}
                </Link>
              ))}
            </nav>
            <div className="settings-content">
              {children}
            </div>
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}

// ── Exported page components (one per child route) ────────────────────────────

export function AutonomyPage() {
  return (
    <SettingsLayout activeSection="autonomy">
      <AutonomySection />
    </SettingsLayout>
  );
}

export function WorkspacePage() {
  return (
    <SettingsLayout activeSection="workspace">
      <div className="settings-page-header">
        <h2 className="settings-page-title">Workspace</h2>
        <p className="settings-page-sub">Workspace settings — coming soon.</p>
      </div>
    </SettingsLayout>
  );
}
