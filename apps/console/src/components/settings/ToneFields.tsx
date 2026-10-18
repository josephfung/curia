import { useState, type CSSProperties } from 'react';
import {
  STYLE_TEMPLATES,
  TONE_STYLE_MAX_LENGTH,
  validateToneStyle,
  verbosityBand,
  formalityBand,
} from '../../pages/wizard-utils';

interface ToneStyleFieldProps {
  value: string;
  onChange: (next: string) => void;
  idPrefix?: string;
}

/**
 * Tone & style: a written description of how the assistant sounds, started from a
 * template. Shared by the wizard and Settings → Personality. A template replaces the
 * text only after the operator confirms, unless the text is empty or already a template.
 */
export function ToneStyleField({ value, onChange, idPrefix = 'tone-style' }: ToneStyleFieldProps) {
  const [pending, setPending] = useState<(typeof STYLE_TEMPLATES)[number] | null>(null);
  // Once edited, an emptied field says why Save is unavailable rather than going quiet.
  const [touched, setTouched] = useState(false);
  const textareaId = `${idPrefix}-text`;
  const error = validateToneStyle(value);
  const active = STYLE_TEMPLATES.find(t => t.text === value.trim());

  function choose(template: (typeof STYLE_TEMPLATES)[number]) {
    const untouched = value.trim() === '' || STYLE_TEMPLATES.some(t => t.text === value.trim());
    if (untouched) {
      onChange(template.text);
      setPending(null);
    } else {
      setPending(template);
    }
  }

  return (
    <>
      <div className="wizard-label" id={`${idPrefix}-templates-label`}>Start from a template</div>
      <div className="tone-pill-grid" role="group" aria-labelledby={`${idPrefix}-templates-label`}>
        {STYLE_TEMPLATES.map(t => (
          <button
            key={t.id}
            type="button"
            className={`tone-pill${active?.id === t.id ? ' selected' : ''}`}
            aria-pressed={active?.id === t.id}
            onClick={() => choose(t)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {pending && (
        <div className="settings-callout" role="alert">
          <p>Replace your text with the {pending.label} template?</p>
          <div className="autonomy-save-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { onChange(pending.text); setPending(null); }}
            >
              Replace
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setPending(null)}>Keep mine</button>
          </div>
        </div>
      )}
      <div className="wizard-field">
        <label htmlFor={textareaId}>Tone &amp; style</label>
        <textarea
          id={textareaId}
          value={value}
          style={{ minHeight: 120 }}
          placeholder="A few lines on how Curia sounds, and what it never does."
          aria-invalid={error !== null}
          aria-describedby={`${idPrefix}-hint`}
          onChange={e => { setTouched(true); onChange(e.target.value); }}
        />
        <div id={`${idPrefix}-hint`} className="settings-muted-hint">
          {value.length} / {TONE_STYLE_MAX_LENGTH} · One example line (Sounds like: "…") does more than any adjective.
        </div>
        {error && (touched || value.length > 0) && <div className="wizard-step1-error">{error}</div>}
      </div>
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

interface DetailSliderProps {
  verbosity: number;
  onChange: (v: number) => void;
  idPrefix?: string;
}

/** The Detail slider: how much the assistant says, from Brief to Thorough. */
export function DetailSlider({ verbosity, onChange, idPrefix = 'asst' }: DetailSliderProps) {
  return (
    <ScaleSlider
      id={`${idPrefix}-verbosity`}
      label="Detail level"
      value={verbosity}
      onChange={onChange}
      leftLabel="Brief"
      rightLabel="Thorough"
      sample={verbosityBand(verbosity)}
    />
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
