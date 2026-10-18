import { BAND_META, BAND_ORDER, type AutonomyBand } from '../../autonomy-bands';

interface AutonomyBandPickerProps {
  value: AutonomyBand;
  onChange: (next: AutonomyBand) => void;
}

/**
 * The setup wizard's autonomy question: how independent Curia should be, as one card per
 * band. Settings → Autonomy tunes the exact score; a picked band saves as its lower bound.
 */
export function AutonomyBandPicker({ value, onChange }: AutonomyBandPickerProps) {
  return (
    <>
      <div className="wizard-label" id="autonomy-band-label">Autonomy</div>
      <div className="posture-grid posture-grid-bands" role="radiogroup" aria-labelledby="autonomy-band-label">
        {BAND_ORDER.map(band => (
          <button
            key={band}
            type="button"
            role="radio"
            aria-checked={value === band}
            className={`posture-card${value === band ? ' selected' : ''}`}
            onClick={() => onChange(band)}
          >
            <div className="posture-card-title">{BAND_META[band].label}</div>
            <div className="posture-card-desc">{BAND_META[band].description}</div>
          </button>
        ))}
      </div>
    </>
  );
}
