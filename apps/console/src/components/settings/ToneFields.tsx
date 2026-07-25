import type { CSSProperties } from 'react';
import {
  TONE_OPTIONS,
  toggleToneSelection,
  tonePreviewText,
  verbosityBand,
  directnessBand,
  formalityBand,
} from '../../pages/wizard-utils';

interface TonePillGridProps {
  selected: string[];
  onChange: (next: string[]) => void;
  idPrefix?: string;
}

/** Shared 1–3 tone pill picker used by the wizard and Assistant settings. */
export function TonePillGrid({ selected, onChange, idPrefix = 'tone' }: TonePillGridProps) {
  const atMax = selected.length >= 3;
  return (
    <>
      <div className="wizard-label" id={`${idPrefix}-label`}>
        Tone{' '}
        <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          (pick up to 3)
        </span>
      </div>
      <div className="tone-pill-grid" role="group" aria-labelledby={`${idPrefix}-label`}>
        {TONE_OPTIONS.map(word => {
          const isSelected = selected.includes(word);
          const disabled = atMax && !isSelected;
          return (
            <button
              key={word}
              type="button"
              className={`tone-pill${isSelected ? ' selected' : ''}`}
              disabled={disabled}
              aria-pressed={isSelected}
              onClick={() => onChange(toggleToneSelection(selected, word))}
            >
              {word}
            </button>
          );
        })}
      </div>
      <div className="wizard-preview">{tonePreviewText(selected)}</div>
    </>
  );
}

interface ScaleSliderProps {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  leftLabel: string;
  rightLabel: string;
  sample: string;
}

function ScaleSlider({ id, label, value, onChange, leftLabel, rightLabel, sample }: ScaleSliderProps) {
  return (
    <>
      <label className="wizard-label" htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        value={value}
        style={{ width: '100%', marginBottom: 6 } as CSSProperties}
        onChange={e => onChange(Number(e.target.value))}
      />
      <div className="slider-labels"><span>{leftLabel}</span><span>{rightLabel}</span></div>
      <div className="wizard-sample">{sample}</div>
    </>
  );
}

interface AssistantToneSlidersProps {
  verbosity: number;
  directness: number;
  onVerbosityChange: (v: number) => void;
  onDirectnessChange: (v: number) => void;
  idPrefix?: string;
}

/** Verbosity + directness sliders for assistant (office identity) tone. */
export function AssistantToneSliders({
  verbosity,
  directness,
  onVerbosityChange,
  onDirectnessChange,
  idPrefix = 'asst',
}: AssistantToneSlidersProps) {
  return (
    <>
      <ScaleSlider
        id={`${idPrefix}-verbosity`}
        label="Detail level"
        value={verbosity}
        onChange={onVerbosityChange}
        leftLabel="Brief"
        rightLabel="Thorough"
        sample={verbosityBand(verbosity)}
      />
      <ScaleSlider
        id={`${idPrefix}-directness`}
        label="Directness"
        value={directness}
        onChange={onDirectnessChange}
        leftLabel="Measured"
        rightLabel="Direct"
        sample={directnessBand(directness)}
      />
    </>
  );
}

interface FormalitySliderProps {
  value: number;
  onChange: (v: number) => void;
  id?: string;
}

/** Formality slider for executive writing voice. */
export function FormalitySlider({ value, onChange, id = 'formality' }: FormalitySliderProps) {
  return (
    <ScaleSlider
      id={id}
      label="Formality"
      value={value}
      onChange={onChange}
      leftLabel="Casual"
      rightLabel="Formal"
      sample={formalityBand(value)}
    />
  );
}
