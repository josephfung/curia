// AttentionList — "does anything need me?": failed/suspended jobs, channels
// that are configured-but-not-enabled, and email accounts missing a grant.
// Each row deep-links to the page where the operator resolves it. When nothing
// is outstanding it renders a green all-clear state.

import { Link } from '@tanstack/react-router';
import { fetchAttention } from './dashboard-utils.js';
import { useAsyncData, TONE_COLOR } from './useAsyncData.js';

export function AttentionList() {
  const { data, error, loading, retry } = useAsyncData(fetchAttention);
  const count = data?.length ?? 0;

  return (
    <article className="dash-card">
      <div className="dash-card-head">
        <span className="dash-card-title">Needs attention</span>
        {data && <span className="dash-count">{count === 0 ? 'clear' : count}</span>}
      </div>

      {loading && !data && !error && <div className="dash-card-quiet">Checking…</div>}

      {error && (
        <div className="dash-alert danger">
          <div className="dash-alert-title">Couldn’t load attention items</div>
          <div className="dash-alert-body">{error}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>Retry</button>
        </div>
      )}

      {data && count === 0 && (
        <div className="dash-alert ok">
          <div className="dash-alert-title">Nothing needs your attention</div>
          <div className="dash-alert-body">No failed jobs, all channels connected, all grants valid.</div>
        </div>
      )}

      {data && count > 0 && (
        <div className="dash-rows">
          {data.map(item => (
            <Link key={item.key} to={item.to} className="dash-row">
              <span className="dash-dot" style={{ background: TONE_COLOR[item.tone] }} />
              <span className="dash-row-text">
                <span className="dash-row-title">{item.title}</span>
                <span className="dash-row-detail">{item.detail}</span>
              </span>
              <svg className="dash-row-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </Link>
          ))}
        </div>
      )}
    </article>
  );
}
