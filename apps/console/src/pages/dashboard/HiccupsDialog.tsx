// HiccupsDialog — the jobs behind the Hiccups tile (#2350): every partly
// failed and failed job of the last 7 days, as Recent Activity rows. The
// backend takes them from the same query as the tile's number, so the list
// and the count agree. Each row links to its job or its Ant Farm replay.

import { Fragment } from 'react';
import { Modal } from '../../components/Modal.js';
import { ActivityRow } from './ActivityFeed.js';
import { fetchHiccups, groupActivityByDay, type HiccupsData } from './dashboard-utils.js';
import { useAsyncData } from './useAsyncData.js';

// Module-level so useAsyncData gets a stable fetcher.
const fetchWeek = (signal: AbortSignal): Promise<HiccupsData> => fetchHiccups(undefined, signal);

export function HiccupsDialog({ onClose }: { onClose: () => void }) {
  const { data, error, loading, retry } = useAsyncData(fetchWeek);

  return (
    <Modal title="Hiccups · last 7 days" onClose={onClose} size="lg" className="dash-hiccups-dialog">
      {loading && !data && !error && <div className="dash-card-quiet">Loading…</div>}

      {error && (
        <div className="dash-alert danger">
          <div className="dash-alert-title">Hiccups unavailable</div>
          <div className="dash-alert-body">{error}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>Retry</button>
        </div>
      )}

      {data && data.items.length === 0 && (
        <div className="dash-card-quiet">No hiccups in the last 7 days.</div>
      )}

      {data && data.items.length > 0 && (
        <div className="dash-activity">
          {groupActivityByDay(data.items, data.timezone).map(group => (
            <Fragment key={group.key}>
              <div className="dash-activity-day">{group.label ?? 'Today'}</div>
              {group.items.map(item => <ActivityRow key={item.id} item={item} timezone={data.timezone} />)}
            </Fragment>
          ))}
          {data.total > data.items.length && (
            <div className="dash-card-quiet dash-activity-more">
              Showing the latest {data.items.length} of {data.total}.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
