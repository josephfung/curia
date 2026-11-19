// Small pieces every Setup step uses (#2358): the radio cards, the status line under a
// step, and the step footer.
import type { JSX, ReactNode } from 'react';

export function Choice(props: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  tag?: string;
}): JSX.Element {
  return (
    <button type="button" role="radio" aria-checked={props.checked} className="setup-choice" onClick={props.onSelect}>
      <span className="setup-radio" aria-hidden="true" />
      <span>
        <b>{props.title}{props.tag && <span className="setup-tag">{props.tag}</span>}</b>
        <span className="setup-choice-desc">{props.description}</span>
      </span>
    </button>
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
