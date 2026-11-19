// Small pieces every Setup step uses (#2358): the radio cards, the status line under a
// step, and the step footer.
import { useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react';

export interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  description: string;
  tag?: string;
  /** Shown but not selectable (e.g. a route that is coming soon); skipped by the arrow keys. */
  disabled?: boolean;
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
  /** No option can be picked for now (e.g. while the step saves); the checked one still shows. */
  disabled?: boolean;
}): JSX.Element {
  const { options, value, onChange } = props;
  const locked = props.disabled === true;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = options.findIndex((o) => o.value === value && !o.disabled);
  const tabStop = checkedIndex >= 0 ? checkedIndex : Math.max(0, options.findIndex((o) => !o.disabled));

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0 || locked) return;
    e.preventDefault();
    const from = refs.current.findIndex((el) => el === document.activeElement);
    let next = from >= 0 ? from : tabStop;
    // Walk past disabled options; stop after a full lap so a group of only one option holds.
    for (let i = 0; i < options.length; i++) {
      next = (next + step + options.length) % options.length;
      if (!options[next]!.disabled) break;
    }
    if (options[next]!.disabled) return;
    refs.current[next]?.focus();
    onChange(options[next]!.value);
  }

  return (
    <div className="setup-choices" role="radiogroup" aria-label={props.label} aria-disabled={props.disabled ? true : undefined} onKeyDown={onKeyDown}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={o.value === value && !o.disabled}
          aria-disabled={o.disabled || locked ? true : undefined}
          tabIndex={i === tabStop ? 0 : -1}
          className="setup-choice"
          onClick={() => { if (!o.disabled && !locked) onChange(o.value); }}
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
