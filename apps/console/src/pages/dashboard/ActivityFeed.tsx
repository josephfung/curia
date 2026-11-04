// ActivityFeed — what Curia did in the last 24 hours, one line per job
// (GET /api/activity?from=<now-24h>&limit=50). The list scrolls inside the
// card so a long day does not grow the page. On a phone the scroll area is capped.

import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  activityHref,
  agentLabel,
  fetchActivity,
  formatActivityTime,
  groupActivityByDay,
  type ActivityItem,
} from './dashboard-utils.js';
import { useAsyncData } from './useAsyncData.js';

function autonomyNote(item: ActivityItem): string | null {
  if (item.autonomy === 'approved') return 'approved';
  if (item.autonomy === 'autonomous') return 'autonomous';
  return null;
}

function Headline({ item }: { item: ActivityItem }) {
  const href = activityHref(item.link);
  if (href && item.link?.kind === 'job') {
    return <Link to="/jobs/$jobId" params={{ jobId: item.link.jobId }} className="dash-activity-headline">{item.headline}</Link>;
  }
  if (href) return <a href={href} className="dash-activity-headline">{item.headline}</a>;
  return <span className="dash-activity-headline">{item.headline}</span>;
}

/** One job: its time, headline (linked to the job or its replay), actor and details. */
export function ActivityRow({ item, timezone }: { item: ActivityItem; timezone: string }) {
  const note = autonomyNote(item);
  return (
    <div className={`dash-activity-item ${item.outcome === 'success' ? '' : item.outcome}`}>
      <span className="dash-activity-time">{formatActivityTime(item.ts, timezone)}</span>
      <div className="dash-activity-text">
        <Headline item={item} />
        <span className="dash-activity-meta">
          {agentLabel(item.actor)}{note ? ` · ${note}` : ''}
          {item.outcome === 'partial' && <span className="dash-activity-partial"> · partly failed</span>}
        </span>
        {item.details.length > 0 && (
          <ul className="dash-activity-details">
            {item.details.map((d, i) => (
              <li key={i} className={`dash-activity-detail ${d.startsWith("couldn't") ? 'failed' : ''}`}>{d}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ActivityFeed() {
  const { data, error, loading, retry } = useAsyncData(fetchActivity);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [data]);

  const countLabel = data
    ? `24h · ${data.items.length}${data.hasMore ? '+' : ''}`
    : null;

  return (
    <article className="dash-card dash-activity-card">
      <div className="dash-card-head">
        <span className="dash-card-title">Recent activity</span>
        {countLabel && <span className="dash-activity-range">{countLabel}</span>}
      </div>

      {loading && !data && !error && <div className="dash-card-quiet">Loading…</div>}

      {error && (
        <div className="dash-alert danger">
          <div className="dash-alert-title">Activity unavailable</div>
          <div className="dash-alert-body">{error}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>Retry</button>
        </div>
      )}

      {data && data.items.length === 0 && (
        <div className="dash-card-quiet">No recent activity yet.</div>
      )}

      {data && data.items.length > 0 && (
        <div className="dash-activity-scroll" ref={scrollRef}>
          <div className="dash-activity">
            {groupActivityByDay(data.items, data.timezone).map(group => (
              <Fragment key={group.key}>
                {group.label && <div className="dash-activity-day">{group.label}</div>}
                {group.items.map(item => <ActivityRow key={item.id} item={item} timezone={data.timezone} />)}
              </Fragment>
            ))}
            {data.hasMore && (
              <div className="dash-card-quiet dash-activity-more">
                Showing the latest {data.items.length}. <a href="/antfarm/">Replay the full day in the Ant Farm</a>.
              </div>
            )}
          </div>
        </div>
      )}
      {overflows && <div className="dash-activity-fade" aria-hidden="true" />}
    </article>
  );
}
