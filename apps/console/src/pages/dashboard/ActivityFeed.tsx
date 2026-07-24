// ActivityFeed — "what's been happening?": recent events from the interpreted
// Ant Farm timeline (GET /api/antfarm/timeline). The timeline returns scene
// directives, not raw audit rows (the only console-facing activity endpoint
// today); each directive is mapped to a readable line, newest first.

import { fetchActivity } from './dashboard-utils.js';
import { useAsyncData } from './useAsyncData.js';

// Local wall-clock formatter for a directive's logical timestamp.
function formatClock(logicalTs: number): string {
  return new Date(logicalTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ActivityFeed() {
  const { data, error, loading, retry } = useAsyncData(fetchActivity);

  return (
    <article className="dash-card">
      <div className="dash-card-head">
        <span className="dash-card-title">Recent activity</span>
      </div>

      {loading && !data && !error && <div className="dash-card-quiet">Loading…</div>}

      {error && (
        <div className="dash-alert danger">
          <div className="dash-alert-title">Timeline unavailable</div>
          <div className="dash-alert-body">{error}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>Retry</button>
        </div>
      )}

      {data && data.length === 0 && (
        <div className="dash-card-quiet">No recent activity yet.</div>
      )}

      {data && data.length > 0 && (
        <div className="dash-activity">
          {data.map(ev => (
            <div key={ev.id} className="dash-activity-item">
              <span className="dash-activity-time">{formatClock(ev.logicalTs)}</span>
              <span className="dash-activity-text">
                <strong>{ev.actor}</strong> {ev.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
