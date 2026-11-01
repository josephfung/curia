// Four value tiles. One stats request feeds all of them. A failure renders an
// em dash and an error — never a zero that would look like a quiet week.

import { useEffect, useId, useState } from 'react';
import {
  fetchStats,
  formatCountDelta,
  formatTimeSaved,
  formatTimeSavedDelta,
} from './dashboard-utils.js';
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

export function BigNumbers({ onHandled, onTimezone }: BigNumbersProps) {
  const { data, error, loading, retry } = useAsyncData(fetchStats);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const weightsId = useId();

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
          <div className="dash-num-value" title={data?.minutesSaved.detail}>{data ? formatTimeSaved(data.minutesSaved.current) : (loading && !error ? '…' : '—')}</div>
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
          <div className="dash-num-value">{data ? data.done.current.toLocaleString('en-US') : (loading && !error ? '…' : '—')}</div>
          {doneDelta && <div className={`dash-delta ${doneDelta.direction}`}>{doneDelta.text}</div>}
        </article>
        <article className="dash-card dash-num">
          <div className="dash-card-title">People known</div>
          <div className="dash-num-value">{data ? data.contacts.total.toLocaleString('en-US') : (loading && !error ? '…' : '—')}</div>
          {data && <div className="dash-num-foot">+{data.contacts.newThisWeek.toLocaleString('en-US')} this week</div>}
        </article>
        <article className="dash-card dash-num">
          <div className="dash-card-title">Hiccups · 7d</div>
          <div className="dash-num-value">{data ? data.hiccups.current.toLocaleString('en-US') : (loading && !error ? '…' : '—')}</div>
          {data && data.hiccups.byDay.length > 0 && <Sparkline values={data.hiccups.byDay} />}
        </article>
      </div>
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
