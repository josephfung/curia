// Four value tiles. One stats request feeds all of them. A failure renders an
// em dash and an error — never a zero that would look like a quiet week.
// While loading, each value is a shimmer bar, so the row reads as loading
// rather than stuck (#2350). Open tasks links to the Tasks page with the
// same filters; Hiccups opens the list of jobs behind its number.

import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  OPEN_TASKS_SEARCH,
  fetchStats,
  formatCountDelta,
  formatTimeSaved,
  formatTimeSavedDelta,
} from './dashboard-utils.js';
import { HiccupsDialog } from './HiccupsDialog.js';
import { useAsyncData } from './useAsyncData.js';

interface BigNumbersProps {
  onHandled: (count: number | null) => void;
  onTimezone: (zone: string) => void;
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  const width = 100;
  const height = 18;
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * width;
    const y = height - (value / max) * (height - 2) - 1;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg className="dash-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline fill="none" stroke="var(--app-destructive)" strokeWidth="1.5" points={points} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A tile's number: the value, a shimmer while loading, or an em dash on error. */
function TileValue({ children, loading, title }: { children: ReactNode; loading: boolean; title?: string }) {
  if (children !== null) return <div className="dash-num-value" title={title}>{children}</div>;
  if (loading) return <div className="dash-num-value"><span className="dash-num-skeleton" aria-label="Loading" /></div>;
  return <div className="dash-num-value">—</div>;
}

export function BigNumbers({ onHandled, onTimezone }: BigNumbersProps) {
  const { data, error, loading, retry } = useAsyncData(fetchStats);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [hiccupsOpen, setHiccupsOpen] = useState(false);
  const weightsId = useId();
  const pending = loading && !error;

  useEffect(() => {
    if (error || !data) {
      onHandled(null);
      return;
    }
    onHandled(data.handledSinceYesterday);
    onTimezone(data.timezone);
  }, [data, error, onHandled, onTimezone]);

  const savedDelta = data ? formatTimeSavedDelta(data.minutesSaved.current, data.minutesSaved.previous) : null;
  const doneDelta = data ? formatCountDelta(data.done.current, data.done.previous) : null;

  return (
    <div className="dash-nums-wrap">
      <div className="dash-nums">
        <article className="dash-card dash-num">
          <div className="dash-card-title">Time saved · 7d</div>
          <TileValue loading={pending} title={data?.minutesSaved.detail}>{data ? formatTimeSaved(data.minutesSaved.current) : null}</TileValue>
          {savedDelta && <div className={`dash-delta ${savedDelta.direction}`}>{savedDelta.text}</div>}
          {data && (
            <>
              <button
                type="button"
                className="dash-num-foot dash-num-weights"
                title={data.minutesSaved.detail}
                aria-expanded={weightsOpen}
                aria-controls={weightsId}
                onClick={() => setWeightsOpen((open) => !open)}
              >
                {data.minutesSaved.help}
              </button>
              <p id={weightsId} className="dash-num-weights-note" hidden={!weightsOpen}>
                {data.minutesSaved.detail}
              </p>
            </>
          )}
        </article>
        <article className="dash-card dash-num">
          <div className="dash-card-title">Done for you · 7d</div>
          <TileValue loading={pending}>{data ? data.done.current.toLocaleString('en-US') : null}</TileValue>
          {doneDelta && <div className={`dash-delta ${doneDelta.direction}`}>{doneDelta.text}</div>}
        </article>
        <Link to="/tasks" search={OPEN_TASKS_SEARCH} className="dash-card dash-num dash-num-link">
          <div className="dash-card-title">Open tasks</div>
          <TileValue loading={pending}>{data ? data.openTasks.total.toLocaleString('en-US') : null}</TileValue>
          {data && (
            <div className={`dash-num-foot${data.openTasks.overdue > 0 ? ' overdue' : ''}`}>
              {data.openTasks.overdue.toLocaleString('en-US')} overdue
            </div>
          )}
        </Link>
        <article className={`dash-card dash-num${data ? ' dash-num-link' : ''}`}>
          {/* The title is the control; its ::after covers the card, so the whole tile clicks. */}
          {data ? (
            <button
              type="button"
              className="dash-card-title dash-num-open"
              onClick={() => setHiccupsOpen(true)}
              aria-haspopup="dialog"
            >
              Hiccups · 7d
            </button>
          ) : (
            <div className="dash-card-title">Hiccups · 7d</div>
          )}
          <TileValue loading={pending}>{data ? data.hiccups.current.toLocaleString('en-US') : null}</TileValue>
          {data && data.hiccups.byDay.length > 0 && <Sparkline values={data.hiccups.byDay} />}
        </article>
      </div>
      {hiccupsOpen && <HiccupsDialog onClose={() => setHiccupsOpen(false)} />}
      {error && (
        <div className="dash-alert danger">
          <div className="dash-alert-title">These numbers are unavailable</div>
          <div className="dash-alert-body">{error}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>Retry</button>
        </div>
      )}
    </div>
  );
}
