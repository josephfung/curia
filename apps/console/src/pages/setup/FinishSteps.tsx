// The Finish steps (#2358): Apply & restart, and Start onboarding.
import { useEffect, useRef, useState, type JSX } from 'react';
import { apiFetch } from '../../api.js';
import { errorMessage } from '../../components/settings/ConfigHistory.js';
import {
  evaluateRestartPoll,
  parseSystemPollResponse,
  restartPollRemainingMs,
  RESTART_POLL_INTERVAL_MS,
  RESTART_TIMEOUT_MS,
} from '../system-utils.js';
import { stepsLeft, type Checklist } from './setup-steps.js';
import { StatusLine, StepFooter } from './setup-ui.js';

type RestartUi =
  | { kind: 'idle' }
  | { kind: 'restarting'; previousBootedAt: string; startedAtMs: number }
  | { kind: 'done' }
  | { kind: 'failed'; message: string };

async function readBootedAt(signal?: AbortSignal): Promise<string> {
  const res = await apiFetch('/api/system', signal ? { signal } : undefined);
  if (!res.ok) throw new Error(await errorMessage(res));
  const parsed = parseSystemPollResponse(res.status, await res.json() as unknown);
  if (parsed.kind !== 'ok') throw new Error('Could not read the server’s start time.');
  return parsed.snapshot.bootedAt;
}

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

/**
 * Locked until every required step is done. This finishes Setup (POST /api/setup/complete):
 * the console leaves this page. The web thread is no longer rotated here; starting onboarding
 * (POST /api/onboarding/start, #2360) rotates it. A full page load follows.
 */
export function StartStep(props: {
  checklist: Checklist | null;
  principal: string;
  onRefresh: () => Promise<void>;
  onHelp?: () => void;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const ready = props.checklist?.setupComplete === true;
  const left = stepsLeft(props.checklist);

  async function start(): Promise<void> {
    setStarting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/setup/complete', { method: 'POST' });
      if (res.status === 409) {
        // A live check changed since the page loaded: re-read the checklist, so the step
        // list and the note show what is missing now, and the button locks again.
        setError('Something stopped passing since this page loaded. The steps below show what’s left.');
        await props.onRefresh();
        setStarting(false);
        return;
      }
      if (!res.ok) throw new Error(await errorMessage(res));
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start onboarding.');
      setStarting(false);
    }
  }

  return (
    <div>
      <h2>Start onboarding</h2>
      <p className="setup-lede">Starting ends Setup and hands Curia to {props.principal}: the console opens on their own, fresh conversation.</p>
      {!ready && left.length > 0 && (
        <div className="setup-note">Finish {left.map((s) => s.name.toLowerCase()).join(', ')} first.</div>
      )}
      {error && <p className="setup-status attention" role="alert">{error}</p>}
      <StepFooter
        primary={starting ? 'Starting…' : 'Start onboarding'}
        primaryDisabled={!ready || starting}
        onPrimary={() => void start()}
        onHelp={props.onHelp}
      />
    </div>
  );
}
