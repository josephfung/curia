// The Finish steps (#2358): Apply & restart, and Start onboarding or Not right now (#2360).
import { useEffect, useRef, useState, type JSX } from 'react';
import { Link } from '@tanstack/react-router';
import { apiFetch } from '../../api.js';
import { Modal } from '../../components/Modal.js';
import { errorMessage } from '../../components/settings/ConfigHistory.js';
import { invitationSummary } from '../devices/invitation-state.js';
import {
  evaluateRestartPoll,
  parseSystemPollResponse,
  restartPollRemainingMs,
  RESTART_POLL_INTERVAL_MS,
  RESTART_TIMEOUT_MS,
} from '../system-utils.js';
import type { MessagingRoute, SetupFor } from './setup-api.js';
import { stepsLeft, type Checklist } from './setup-steps.js';
import { StatusLine, StepFooter } from './setup-ui.js';
import {
  helloText,
  invitationMessage,
  notRightNowText,
  readBootedAt,
  RESTART_SLOW,
  ROUTE_LABEL,
  signalText,
  useStartOnboarding,
  type StartFlow,
} from './start-onboarding.js';

type RestartUi =
  | { kind: 'idle' }
  | { kind: 'restarting'; previousBootedAt: string; startedAtMs: number }
  | { kind: 'done' }
  | { kind: 'failed'; message: string };

/**
 * One restart turns on everything saved, then every step is checked again. Polls
 * GET /api/system until bootedAt changes, as Settings → System → About does.
 */
export function ApplyStep(props: {
  checklist: Checklist | null;
  onSaved: () => Promise<void>;
  onContinue: () => void;
  onHelp?: () => void;
}): JSX.Element {
  const [ui, setUi] = useState<RestartUi>({ kind: 'idle' });
  const posting = useRef(false);
  const waiting = props.checklist?.tasks.filter((t) => !t.optional && t.restart_required) ?? [];
  const { onSaved } = props;

  useEffect(() => {
    if (ui.kind !== 'restarting') return;
    const { previousBootedAt, startedAtMs } = ui;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const remaining = restartPollRemainingMs(startedAtMs, Date.now(), RESTART_TIMEOUT_MS);
    const deadline = setTimeout(() => {
      cancelled = true;
      controller?.abort();
      setUi({ kind: 'failed', message: 'Curia hasn’t come back yet. Check that its container restarted, then reload this page.' });
    }, remaining);

    async function pollOnce(): Promise<void> {
      if (cancelled) return;
      controller = new AbortController();
      let fetched: ReturnType<typeof parseSystemPollResponse> | { kind: 'transport_error' };
      try {
        const res = await apiFetch('/api/system', { signal: controller.signal });
        let body: unknown = null;
        try { body = await res.json(); } catch { body = null; }
        fetched = parseSystemPollResponse(res.status, body);
      } catch {
        // The server is down mid-restart: expected, so keep polling until the deadline.
        fetched = { kind: 'transport_error' };
      }
      if (cancelled) return;
      const decision = evaluateRestartPoll({ previousBootedAt, startedAtMs, nowMs: Date.now(), timeoutMs: RESTART_TIMEOUT_MS, fetch: fetched });
      if (decision.kind === 'succeeded') {
        clearTimeout(deadline);
        setUi({ kind: 'done' });
        await onSaved();
        return;
      }
      if (decision.kind === 'timeout') {
        clearTimeout(deadline);
        setUi({ kind: 'failed', message: 'Curia hasn’t come back yet. Check that its container restarted, then reload this page.' });
        return;
      }
      pollTimer = setTimeout(() => void pollOnce(), RESTART_POLL_INTERVAL_MS);
    }
    void pollOnce();
    return () => {
      cancelled = true;
      clearTimeout(deadline);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      controller?.abort();
    };
  }, [ui, onSaved]);

  async function restart(): Promise<void> {
    if (posting.current) return;
    posting.current = true;
    try {
      const previousBootedAt = await readBootedAt();
      const res = await apiFetch('/api/system/restart', { method: 'POST' });
      if (res.status === 429) throw new Error('Too many restarts in a row. Try again in a few minutes.');
      if (!res.ok) throw new Error(await errorMessage(res));
      setUi({ kind: 'restarting', previousBootedAt, startedAtMs: Date.now() });
    } catch (err) {
      setUi({ kind: 'failed', message: err instanceof Error ? err.message : 'Could not restart.' });
    } finally {
      posting.current = false;
    }
  }

  return (
    <div>
      <h2>Apply and restart</h2>
      <p className="setup-lede">Curia restarts once to turn on everything you’ve set up, then checks each step again. It takes about a minute.</p>
      {waiting.length > 0 && ui.kind === 'idle' && (
        <StatusLine kind="attention">Waiting for a restart: {waiting.map((t) => t.label).join(', ')}.</StatusLine>
      )}
      {ui.kind === 'restarting' && <StatusLine kind="neutral">Restarting… this page reconnects by itself.</StatusLine>}
      {ui.kind === 'done' && <StatusLine kind="ok">Restarted. Every step was checked again.</StatusLine>}
      {ui.kind === 'failed' && <p className="setup-status attention" role="alert">{ui.message}</p>}
      {/* Once the restart lands, the step's job is done: the button moves on. */}
      <StepFooter
        primary={ui.kind === 'done' ? 'Continue' : ui.kind === 'restarting' ? 'Restarting…' : 'Apply and restart'}
        primaryDisabled={ui.kind === 'restarting'}
        onPrimary={ui.kind === 'done' ? props.onContinue : () => void restart()}
        onHelp={props.onHelp}
      />
    </div>
  );
}

/** Before starting on an install that already looks in use: what was seen, and a confirm. */
export function WorkingPrincipalDialog(props: {
  signals: string[];
  principal: string;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <Modal
      title="Start onboarding anyway?"
      onClose={props.onCancel}
      footer={(
        <>
          <button type="button" className="btn" data-autofocus onClick={props.onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={props.onConfirm}>Start onboarding</button>
        </>
      )}
    >
      <p>Curia already looks in use:</p>
      <ul>{props.signals.map((s) => <li key={s}>{signalText(s, props.principal)}</li>)}</ul>
      <p>Starting onboarding holds Email triage until {props.principal} hears what to expect.</p>
    </Modal>
  );
}

/**
 * Why Start failed. Refused as unreachable on Signal, SMS or Slack, it links the places to fix it:
 * Setup is over by then, so the Setup page's Messaging step is gone.
 */
export function StartFailure(props: {
  flow: Extract<StartFlow, { kind: 'failed' }>;
  principal: string;
  className: string;
}): JSX.Element {
  const { flow, principal } = props;
  const route = flow.unreachable;
  if (!route || route === 'app') return <p className={props.className} role="alert">{flow.message}</p>;
  const label = ROUTE_LABEL[route];
  return (
    <p className={props.className} role="alert">
      Curia can’t reach {principal} on {label} yet. Check that the {label} channel is on
      in <Link to="/channels" search={{ channel: route }}>Channels</Link> and that {principal}’s {label} details
      are on their <Link to="/contacts">contact</Link>.
    </p>
  );
}

/**
 * What Start did: the invitation link with wording to send (the app route), or what Curia sent
 * (the others), and, when Start restarts Curia, the wait for it to come back.
 */
export function OnboardingStarted(props: {
  flow: Extract<StartFlow, { kind: 'started' }>;
  route: MessagingRoute | null;
  setupFor: SetupFor | null;
  principal: string;
  continueLabel: string;
  onContinue: () => void;
}): JSX.Element {
  const { flow, principal, setupFor } = props;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const invitation = flow.invitation;
  const self = setupFor === 'self';
  const message = invitation ? invitationMessage(invitation.url, setupFor, principal) : null;
  const hello = invitation ? null : helloText(props.route);

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (err) {
      console.error('[onboarding] copy failed:', err);
      setCopyError('Could not copy it. Select it and copy it by hand.');
    }
  }

  return (
    <div className="onboarding-started">
      <StatusLine kind="ok">Onboarding started.</StatusLine>
      {invitation && message && (
        <>
          <p>
            {self
              ? 'This invitation is for you: open it on your phone to install Curia and sign in. Curia says hello once you’re in. The link is valid for 48 hours.'
              : `Send ${principal} this invitation, in a text or a message. It installs Curia on their phone, and Curia says hello once they’re in. The link is valid for 48 hours.`}
          </p>
          <div className="pair-code">
            <input
              className="invite-link"
              aria-label="Invitation link"
              readOnly
              value={invitation.url}
              onFocus={(event) => event.currentTarget.select()}
            />
            {!self && <p className="onboarding-message">{message}</p>}
            <div className="invite-actions">
              <button type="button" className="btn btn-primary" onClick={() => { void copy(self ? invitation.url : message); }}>
                {copied ? 'Copied ✓' : self ? 'Copy link' : 'Copy message'}
              </button>
            </div>
            <p className="device-meta">
              {invitationSummary({ id: '', state: 'waiting', expiresAt: invitation.expiresAt, redeemedAt: null, deviceName: null })}.
              {' '}This is the only time the link is shown. If you lose it, create a new one from Devices.
            </p>
          </div>
          {copyError && <p className="setup-status attention" role="alert">{copyError}</p>}
        </>
      )}
      {hello && <p>{hello}</p>}
      {flow.restart === 'waiting' && <StatusLine kind="neutral">Curia is restarting to switch on Email triage, held for now… this page reconnects by itself.</StatusLine>}
      {flow.restart === 'back' && <StatusLine kind="ok">Curia restarted.</StatusLine>}
      {flow.restart === 'slow' && <p className="setup-status attention" role="alert">{RESTART_SLOW}</p>}
      {flow.restart === 'unknown' && <StatusLine kind="neutral">Curia is restarting to switch on Email triage, held for now. Give it a minute; if the console doesn’t respond, reload the page.</StatusLine>}
      <div className="setup-foot">
        <button type="button" className="btn btn-primary" disabled={flow.restart === 'waiting'} onClick={props.onContinue}>
          {props.continueLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Locked until every required step is done. Both choices finish Setup (POST /api/setup/complete):
 * Start onboarding then starts it (POST /api/onboarding/start, which rotates the web thread);
 * Not right now asks first, and leaves it for the dashboard alert. A full page load follows.
 */
export function StartStep(props: {
  checklist: Checklist | null;
  principal: string;
  setupFor: SetupFor | null;
  route: MessagingRoute | null;
  onRefresh: () => Promise<void>;
  onHelp?: () => void;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState<'start' | 'later' | null>(null);
  const [notNow, setNotNow] = useState(false);
  const ready = props.checklist?.setupComplete === true;
  const left = stepsLeft(props.checklist);
  const { flow, start, cancel } = useStartOnboarding({ principal: props.principal, route: props.route, onSetupIncomplete: props.onRefresh });
  const busy = finishing !== null || flow.kind === 'working';

  /** POST /api/setup/complete. True when Setup is over; otherwise the step says why. */
  async function finishSetup(choice: 'start' | 'later'): Promise<boolean> {
    setFinishing(choice);
    setError(null);
    try {
      const res = await apiFetch('/api/setup/complete', { method: 'POST' });
      if (res.status === 409) {
        // A live check changed since the page loaded: re-read the checklist, so the step
        // list and the note show what is missing now, and the buttons lock again.
        setError('Something stopped passing since this page loaded. The steps below show what’s left.');
        await props.onRefresh();
        return false;
      }
      if (!res.ok) throw new Error(await errorMessage(res));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not finish Setup.');
      return false;
    } finally {
      setFinishing(null);
    }
  }

  async function startOnboarding(): Promise<void> {
    if (await finishSetup('start')) await start(false);
  }

  async function notRightNow(): Promise<void> {
    setNotNow(false);
    if (await finishSetup('later')) window.location.assign('/');
  }

  if (flow.kind === 'started') {
    return (
      <div>
        <h2>Start onboarding</h2>
        <OnboardingStarted
          flow={flow}
          route={props.route}
          setupFor={props.setupFor}
          principal={props.principal}
          continueLabel="Open the console"
          onContinue={() => window.location.assign('/')}
        />
      </div>
    );
  }

  return (
    <div>
      <h2>Start onboarding</h2>
      <p className="setup-lede">
        Onboarding is {props.setupFor === 'self' ? 'your' : `${props.principal}’s`} first conversation with Curia. Start it now, or later from the dashboard. Either way, this ends Setup.
      </p>
      {!ready && left.length > 0 && (
        <div className="setup-note">Finish {left.map((s) => s.name.toLowerCase()).join(', ')} first.</div>
      )}
      {flow.kind === 'already_started' && <StatusLine kind="ok">Onboarding has already started.</StatusLine>}
      {error && <p className="setup-status attention" role="alert">{error}</p>}
      {flow.kind === 'failed' && <StartFailure flow={flow} principal={props.principal} className="setup-status attention" />}
      {flow.kind === 'confirm' && (
        <WorkingPrincipalDialog
          signals={flow.signals}
          principal={props.principal}
          onConfirm={() => void start(true)}
          onCancel={cancel}
        />
      )}
      {notNow && (
        <Modal
          title="Not right now?"
          onClose={() => setNotNow(false)}
          footer={(
            <>
              <button type="button" className="btn" data-autofocus onClick={() => setNotNow(false)}>Back</button>
              <button type="button" className="btn btn-primary" onClick={() => void notRightNow()}>Finish Setup</button>
            </>
          )}
        >
          <p>{notRightNowText(props.setupFor, props.principal)}</p>
        </Modal>
      )}
      {flow.kind === 'already_started' ? (
        <StepFooter primary="Open the console" onPrimary={() => window.location.assign('/')} onHelp={props.onHelp} />
      ) : (
        <StepFooter
          primary={busy && finishing !== 'later' ? 'Starting…' : 'Start onboarding'}
          primaryDisabled={!ready || busy}
          onPrimary={() => void startOnboarding()}
          secondary={finishing === 'later' ? 'Finishing…' : 'Not right now'}
          secondaryDisabled={!ready || busy}
          onSecondary={() => setNotNow(true)}
          onHelp={props.onHelp}
        />
      )}
    </div>
  );
}
