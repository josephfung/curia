import { MAX_VELOCITY, MIN_VELOCITY } from '../conductor/types.js';

interface TransportBarProps {
  mode: 'paused' | 'playing' | 'live';
  velocity: number;
  onPlay: () => void;
  onPause: () => void;
  onLive: () => void;
  onVelocityChange: (v: number) => void;
  onScrub: (pct: number) => void;
  scrubPct: number;
  filterConversation: string;
  filterAgent: string;
  filterKind: string;
  onFilterConversation: (v: string) => void;
  onFilterAgent: (v: string) => void;
  onFilterKind: (v: string) => void;
}

export function TransportBar({
  mode,
  velocity,
  onPlay,
  onPause,
  onLive,
  onVelocityChange,
  onScrub,
  scrubPct,
  filterConversation,
  filterAgent,
  filterKind,
  onFilterConversation,
  onFilterAgent,
  onFilterKind,
}: TransportBarProps) {
  return (
    <div className="transport">
      <div className="transport-controls">
        <button type="button" onClick={onPlay} disabled={mode === 'playing'}>Play</button>
        <button type="button" onClick={onPause} disabled={mode === 'paused'}>Pause</button>
        <button type="button" onClick={onLive} className={mode === 'live' ? 'active' : ''}>Live</button>
        <label>
          Speed
          <input
            type="range"
            min={MIN_VELOCITY}
            max={MAX_VELOCITY}
            step={0.25}
            value={velocity}
            onChange={(e) => onVelocityChange(Number(e.target.value))}
          />
          <span>{velocity}×</span>
        </label>
      </div>
      <input
        className="scrubber"
        type="range"
        min={0}
        max={100}
        value={scrubPct}
        onChange={(e) => onScrub(Number(e.target.value))}
      />
      <div className="filters">
        <input
          placeholder="Conversation id"
          value={filterConversation}
          onChange={(e) => onFilterConversation(e.target.value)}
        />
        <input
          placeholder="Agent id"
          value={filterAgent}
          onChange={(e) => onFilterAgent(e.target.value)}
        />
        <input
          placeholder="Event kind"
          value={filterKind}
          onChange={(e) => onFilterKind(e.target.value)}
        />
      </div>
    </div>
  );
}
