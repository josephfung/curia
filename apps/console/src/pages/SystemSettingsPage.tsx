import { useCallback, useEffect, useRef, useState } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';
import { errorMessage, timeAgo } from '../components/settings/ConfigHistory.js';
import {
  RESTART_POLL_INTERVAL_MS,
  RESTART_TIMEOUT_MS,
  elapsedSeconds,
  evaluateRestartPoll,
  formatRestartSuccess,
  isSystemInfo,
  parseSystemPollResponse,
  restartPollRemainingMs,
  type SystemInfo,
} from './system-utils.js';

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

type RestartUi =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'restarting'; previousBootedAt: string; startedAtMs: number }
  | { kind: 'succeeded'; elapsedMs: number }
  | { kind: 'failed' };

function SystemSection() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restartUi, setRestartUi] = useState<RestartUi>({ kind: 'idle' });
  const [restartError, setRestartError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [restartPosting, setRestartPosting] = useState(false);
  const postingRef = useRef(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await apiFetch('/api/system');
        if (!res.ok) throw new Error(await errorMessage(res));
        const data = await res.json() as { system: unknown };
        if (!isSystemInfo(data.system)) {
          throw new Error('Malformed system response');
        }
        setInfo(data.system);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load system info');
      }
    }
    void load();
  }, []);

  // Elapsed-seconds ticker while the process is down.
  useEffect(() => {
    if (restartUi.kind !== 'restarting') return;
    setElapsedSec(elapsedSeconds(restartUi.startedAtMs, Date.now()));
    const id = setInterval(() => {
      setElapsedSec(elapsedSeconds(restartUi.startedAtMs, Date.now()));
    }, 1_000);
    return () => clearInterval(id);
  }, [restartUi]);

  // Poll GET /api/system until bootedAt changes or the ceiling is hit.
  // Connection errors are expected (the server is down) and never surface.
  // A hung GET must not block the ceiling: abort the in-flight request and
  // flip to failed when RESTART_TIMEOUT_MS elapses (#1765 / CodeRabbit).
  useEffect(() => {
    if (restartUi.kind !== 'restarting') return;
    const { previousBootedAt, startedAtMs } = restartUi;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const remaining = restartPollRemainingMs(startedAtMs, Date.now(), RESTART_TIMEOUT_MS);
    if (remaining === 0) {
      setRestartUi({ kind: 'failed' });
      return;
    }

    const deadlineTimer = setTimeout(() => {
      cancelled = true;
      controller?.abort();
      setRestartUi({ kind: 'failed' });
    }, remaining);

    async function pollOnce() {
      if (cancelled) return;
      controller = new AbortController();
      let fetchResult: ReturnType<typeof parseSystemPollResponse> | { kind: 'transport_error' };
      try {
        const res = await apiFetch('/api/system', { signal: controller.signal });
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        fetchResult = parseSystemPollResponse(res.status, body);
      } catch {
        fetchResult = { kind: 'transport_error' };
      }
      if (cancelled) return;
      const decision = evaluateRestartPoll({
        previousBootedAt,
        startedAtMs,
        nowMs: Date.now(),
        timeoutMs: RESTART_TIMEOUT_MS,
        fetch: fetchResult,
      });
      if (decision.kind === 'succeeded') {
        clearTimeout(deadlineTimer);
        setInfo(decision.snapshot);
        setRestartUi({ kind: 'succeeded', elapsedMs: Date.now() - startedAtMs });
        return;
      }
      if (decision.kind === 'timeout') {
        clearTimeout(deadlineTimer);
        setRestartUi({ kind: 'failed' });
        return;
      }
      pollTimer = setTimeout(() => void pollOnce(), RESTART_POLL_INTERVAL_MS);
    }

    void pollOnce();
    return () => {
      cancelled = true;
      clearTimeout(deadlineTimer);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      controller?.abort();
    };
  }, [restartUi]);

  const fireRestart = useCallback(async (previousBootedAt: string) => {
    if (postingRef.current) return;
    postingRef.current = true;
    setRestartPosting(true);
    setRestartError(null);
    const startedAtMs = Date.now();
    try {
      const res = await apiFetch('/api/system/restart', { method: 'POST' });
      if (res.status === 429) {
        throw new Error('Too many restart attempts. Try again in a few minutes.');
      }
      if (!res.ok) throw new Error(await errorMessage(res));
      setRestartUi({ kind: 'restarting', previousBootedAt, startedAtMs });
    } catch (err) {
      setRestartUi({ kind: 'idle' });
      setRestartError(err instanceof Error ? err.message : 'Failed to restart');
    } finally {
      postingRef.current = false;
      setRestartPosting(false);
    }
  }, []);

  if (loadError) {
    return (
      <div className="settings-page-header">
        <p className="autonomy-error">{loadError}</p>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="settings-page-header">
        <p className="settings-muted-hint">Loading…</p>
      </div>
    );
  }

  const restarting = restartUi.kind === 'restarting';

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">System</h2>
        <p className="settings-page-sub">
          Environment and configuration for this Curia instance.
        </p>
      </div>

      <div className="settings-callout settings-callout-readonly">
        <p>
          <strong>Read-only.</strong> These values reflect the currently running process.
          Enabling a tool or agent takes effect after a restart, which you can trigger below.
        </p>
      </div>

      {restartUi.kind === 'succeeded' && (
        <div className="settings-callout settings-callout-success" role="status">
          <p>{formatRestartSuccess(restartUi.elapsedMs)}</p>
        </div>
      )}

      {restartUi.kind === 'failed' && (
        <div className="settings-callout settings-callout-danger" role="alert">
          <p>
            Curia did not come back within {Math.round(RESTART_TIMEOUT_MS / 1000)}s.
            If this instance runs in Docker, check the container. If you started it with{' '}
            <code>pnpm dev</code>, there is no supervisor — restart the process yourself.
          </p>
        </div>
      )}

      <section className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Instance</h3>
        </div>
        <div className="settings-section-body">
          <dl className="settings-kv-list">
            <div className="settings-kv-row">
              <dt>Curia version</dt>
              <dd><code>{info.version}</code></dd>
            </div>
            <div className="settings-kv-row">
              <dt>Node runtime</dt>
              <dd><code>{info.nodeVersion}</code></dd>
            </div>
            <div className="settings-kv-row">
              <dt>Timezone</dt>
              <dd>{info.timezone}</dd>
            </div>
            <div className="settings-kv-row">
              <dt>Booted</dt>
              <dd title={info.bootedAt}>{timeAgo(info.bootedAt)}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Models</h3>
          <p className="settings-section-sub">
            Capability tier → model routing. Agents pick a tier; the deployment maps it here.
          </p>
        </div>
        <div className="settings-section-body">
          <dl className="settings-kv-list">
            {info.models.tiers.map(t => (
              <div className="settings-kv-row" key={t.tier}>
                <dt>
                  {capitalize(t.tier)}
                  {t.tier === info.models.defaultTier && (
                    <span className="settings-kv-tag">default</span>
                  )}
                </dt>
                <dd><code>{t.model}</code></dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-section-title">Maintenance</h3>
          <p className="settings-section-sub">
            Enabling a tool or agent does not take effect until the process restarts.
          </p>
        </div>
        <div className="settings-section-body">
          {restartUi.kind === 'confirming' ? (
            <div className="restart-confirm">
              <p>
                Restarting drops in-flight agent runs and any live voice call.
                Docker brings the process back on its own. A bare{' '}
                <code>pnpm dev</code> process will exit and stay down.
              </p>
              <div className="restart-confirm-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={restartPosting}
                  onClick={() => setRestartUi({ kind: 'idle' })}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={restartPosting}
                  onClick={() => void fireRestart(info.bootedAt)}
                >
                  {restartPosting ? 'Restarting…' : 'Restart now'}
                </button>
              </div>
            </div>
          ) : (
            <div className="restart-confirm-actions">
              <button
                type="button"
                className="btn btn-danger"
                disabled={restarting}
                onClick={() => {
                  setRestartError(null);
                  setRestartUi({ kind: 'confirming' });
                }}
              >
                {restarting ? (
                  <>
                    <span className="restart-spinner" aria-hidden="true" />
                    Restarting… {elapsedSec}s
                  </>
                ) : (
                  'Restart'
                )}
              </button>
            </div>
          )}
          {restartError && (
            <p className="autonomy-error" style={{ marginTop: 12 }}>{restartError}</p>
          )}
        </div>
      </section>
    </>
  );
}

export function SystemPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="system" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}
        <main className="main">
          <Topbar crumb="Settings" title="System" />
          <div className="settings-shell">
            <div className="settings-content">
              <SystemSection />
            </div>
          </div>
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}

export default SystemPage;
