// The Capabilities list (#2358 section 4), used in two places: the last optional extra on the
// Setup page, and Settings → Capabilities. One switch per capability; a switch flips every
// registry entry the capability covers through the existing /api/registry routes. Registry
// changes apply at the next restart.
import { useCallback, useEffect, useState, type JSX } from 'react';
import { apiFetch } from '../../api.js';
import { errorMessage } from '../../components/settings/ConfigHistory.js';
import type { RegistryEntry } from '../registry-rows.js';
import {
  CAPABILITIES,
  capabilityState,
  offWarning,
  switchPlan,
  type Capability,
  type CapabilityId,
  type RegistryLists,
} from './capabilities.js';

async function loadLists(): Promise<RegistryLists> {
  const read = async <K extends string>(kind: K): Promise<RegistryEntry[]> => {
    const res = await apiFetch(`/api/registry/${kind}`);
    if (!res.ok) throw new Error(await errorMessage(res));
    return (await res.json() as Record<K, RegistryEntry[]>)[kind];
  };
  const [agents, skills, tools] = await Promise.all([read('agents'), read('skills'), read('tools')]);
  return { agents, skills, tools };
}

export function CapabilitiesSection(props: {
  /** How the descriptions name the principal ("Dana", or "your principal"). */
  principal: string;
  /** Setup locks Email triage off; Settings lets it be switched. */
  place: 'setup' | 'settings';
  /** Asks before turning off a capability other parts of Curia use (window.confirm). */
  confirm?: (text: string) => boolean;
  onChanged?: () => void;
}): JSX.Element {
  const { principal, place } = props;
  const confirm = props.confirm ?? ((text: string) => window.confirm(text));
  const [lists, setLists] = useState<RegistryLists | null>(null);
  const [busy, setBusy] = useState<CapabilityId | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const reload = useCallback(async (): Promise<RegistryLists | null> => {
    try {
      const next = await loadLists();
      setLists(next);
      return next;
    } catch (err) {
      setMessage({ kind: 'error', text: `Couldn’t read Curia’s capabilities: ${err instanceof Error ? err.message : 'unknown error'}` });
      return null;
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  async function flip(cap: Capability, on: boolean): Promise<void> {
    if (!lists) return;
    if (!on) {
      const warning = offWarning(cap, lists);
      if (warning && !confirm(warning)) return;
    }
    setBusy(cap.id);
    setMessage(null);
    let done = 0;
    const plan = switchPlan(cap, on, lists);
    try {
      // One at a time, in the plan's order, so a failure leaves the safe side of it done.
      for (const step of plan) {
        const res = await apiFetch(`/api/registry/${step.kind}/${encodeURIComponent(step.name)}/${step.action}`, { method: 'POST' });
        if (!res.ok) throw new Error(`${step.name}: ${await errorMessage(res)}`);
        done++;
      }
      setMessage({ kind: 'ok', text: `${cap.label} ${on ? 'on' : 'off'}. ${restartNote(place)}` });
    } catch (err) {
      const text = err instanceof Error ? err.message : 'unknown error';
      setMessage({
        kind: 'error',
        text: done > 0
          ? `Couldn’t finish turning ${cap.label} ${on ? 'on' : 'off'} (${text}). Part of it changed; the switch shows where it is now.`
          : `Couldn’t turn ${cap.label} ${on ? 'on' : 'off'}: ${text}`,
      });
    } finally {
      await reload();
      setBusy(null);
      if (done > 0) props.onChanged?.();
    }
  }

  return (
    <div className="caps">
      {CAPABILITIES.map((cap) => {
        const state = lists ? capabilityState(cap, lists) : null;
        const on = state?.kind === 'on' || cap.lock === 'always-on';
        const lockedOff = cap.lock === 'principal-in-onboarding' && place === 'setup';
        const fixed = cap.lock === 'always-on' ? 'Always on'
          : lockedOff ? `${principal.charAt(0).toUpperCase()}${principal.slice(1)} turns this on during onboarding`
          : state?.kind === 'unavailable' ? 'Not available on this install'
          : state?.kind === 'partly' ? 'Partly on' : null;
        const disabled = !state || busy !== null || cap.lock === 'always-on' || lockedOff || state.kind === 'unavailable';
        const descId = `cap-${cap.id}-desc`;
        return (
          <div className="cap" key={cap.id}>
            <div>
              <b>{cap.label}</b>
              <span className="cap-desc" id={descId}>{cap.description(principal)}</span>
            </div>
            {fixed && <span className="cap-fixed">{fixed}</span>}
            <button
              type="button"
              role="switch"
              className="cap-switch"
              aria-checked={lockedOff ? false : on}
              aria-label={cap.label}
              aria-describedby={descId}
              disabled={disabled}
              onClick={() => void flip(cap, !(state?.kind === 'on'))}
            />
          </div>
        );
      })}
      {!lists && !message && <p className="setup-hint">Loading…</p>}
      {message && (
        <p className={`setup-status ${message.kind === 'ok' ? 'ok' : 'attention'}`} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </div>
  );
}

function restartNote(place: 'setup' | 'settings'): string {
  return place === 'setup' ? 'It applies when you apply and restart.' : 'It applies after a restart.';
}
