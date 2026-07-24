// HealthCard — traffic-light system health from GET /api/health.
//
// A 503 "down" body is rendered as a red status, NOT an error state (that
// branch lives in fetchHealth). Per-check pills reuse the existing .status-pill
// classes; nested mcp.* checks are flattened into their own pills.

import {
  fetchHealth,
  flattenHealthChecks,
  healthCheckPillClass,
  healthStatusMeta,
  formatUptime,
} from './dashboard-utils.js';
import { useAsyncData, TONE_COLOR } from './useAsyncData.js';

export function HealthCard() {
  const { data, error, loading, retry } = useAsyncData(fetchHealth);

  return (
    <article className="dash-card">
      <div className="dash-card-head">
        <span className="dash-card-title">System health</span>
      </div>

      {loading && !data && !error && <div className="dash-card-quiet">Checking…</div>}

      {error && (
        <div className="dash-alert danger">
          <div className="dash-alert-title">Health check unavailable</div>
          <div className="dash-alert-body">{error}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>Retry</button>
        </div>
      )}

      {data && (() => {
        const meta = healthStatusMeta(data.status);
        const pills = flattenHealthChecks(data.checks);
        const httpCode = data.status === 'down' ? 'HTTP 503' : 'HTTP 200';
        return (
          <>
            <div className="dash-health-status">
              <span className="dash-dot dash-dot-lg" style={{ background: TONE_COLOR[meta.tone] }} />
              <div className="dash-health-status-text">
                <span className="dash-health-label">{meta.label}</span>
                <span className="dash-health-meta">uptime {formatUptime(data.uptime_s)} · {httpCode}</span>
              </div>
            </div>
            <div className="dash-pills">
              {pills.map(p => (
                <span key={p.name} className={`status-pill ${healthCheckPillClass(p.result)}`}>{p.name}</span>
              ))}
            </div>
          </>
        );
      })()}
    </article>
  );
}
