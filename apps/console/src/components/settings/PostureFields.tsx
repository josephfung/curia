import { POSTURE_OPTIONS, type DecisionPosture } from '../../pages/wizard-utils';

interface PostureCardGridProps {
  value: DecisionPosture;
  onChange: (next: DecisionPosture) => void;
  /** Optional label suffix shown after "Decision posture". */
  scopeHint?: string;
}

/** Shared Conservative / Balanced / Proactive card picker. */
export function PostureCardGrid({ value, onChange, scopeHint }: PostureCardGridProps) {
  return (
    <>
      <div className="wizard-label">
        Decision posture{' '}
        {scopeHint && (
          <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--app-fg-muted)' }}>
            {scopeHint}
          </span>
        )}
      </div>
      <div className="posture-grid" role="radiogroup" aria-label="Decision posture">
        {POSTURE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={value === opt.value}
            className={`posture-card${value === opt.value ? ' selected' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            <div className="posture-card-title">{opt.title}</div>
            <div className="posture-card-desc">{opt.desc}</div>
          </button>
        ))}
      </div>
    </>
  );
}
