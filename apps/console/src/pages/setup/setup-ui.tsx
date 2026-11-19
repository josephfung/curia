// Small pieces every Setup step uses (#2358): the radio cards, the status line under a
// step, and the step footer.
import { useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react';

export interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  description: string;
  tag?: string;
}

/**
 * A group of radio cards with the WAI-ARIA radio pattern: one tab stop (the checked card,
 * or the first when none is), and the arrow keys move the selection and the focus.
 */
export function ChoiceGroup<T extends string>(props: {
  label: string;
  options: ReadonlyArray<ChoiceOption<T>>;
  value: T | null;
  onChange: (value: T) => void;
}): JSX.Element {
  const { options, value, onChange } = props;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = options.findIndex((o) => o.value === value);
  const tabStop = checkedIndex >= 0 ? checkedIndex : 0;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const from = refs.current.findIndex((el) => el === document.activeElement);
    const next = ((from >= 0 ? from : tabStop) + step + options.length) % options.length;
    refs.current[next]?.focus();
    onChange(options[next]!.value);
  }

  return (
    <div className="setup-choices" role="radiogroup" aria-label={props.label} onKeyDown={onKeyDown}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === tabStop ? 0 : -1}
          className="setup-choice"
          onClick={() => onChange(o.value)}
        >
          <span className="setup-radio" aria-hidden="true" />
          <span>
            <b>{o.title}{o.tag && <span className="setup-tag">{o.tag}</span>}</b>
            <span className="setup-choice-desc">{o.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** One line under a step: done (teal), needs attention (amber) or neutral. */
export function StatusLine(props: { kind: 'ok' | 'attention' | 'neutral'; children: ReactNode }): JSX.Element {
  return (
    <p className={`setup-status ${props.kind === 'neutral' ? '' : props.kind}`} role="status">
      {props.kind === 'ok' && <span aria-hidden="true">✓ </span>}
      {props.children}
    </p>
  );
}

export function StepFooter(props: {
  primary?: string;
  primaryDisabled?: boolean;
  /** True: the primary button submits the step's form. Otherwise it calls onPrimary. */
  submit?: boolean;
  onPrimary?: () => void;
  onHelp?: () => void;
}): JSX.Element {
  return (
    <div className="setup-foot">
      {props.primary && (
        <button
          type={props.submit ? 'submit' : 'button'}
          className="btn btn-primary"
          disabled={props.primaryDisabled}
          onClick={props.submit ? undefined : props.onPrimary}
        >
          {props.primary}
        </button>
      )}
      {props.onHelp && (
        <button type="button" className="setup-link setup-help" onClick={props.onHelp}>Need help? Ask the setup guide</button>
      )}
    </div>
  );
}
