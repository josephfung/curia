// The Capabilities list (#2358 section 4), used in two places: the last optional extra on the
// Setup page, and Settings → Capabilities. One switch per capability; a switch flips every
// registry entry the capability covers through the existing /api/registry routes. Registry
// changes apply at the next restart.
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type JSX, type Ref } from 'react';
import { apiFetch } from '../../api.js';
import { errorMessage } from '../../components/settings/ConfigHistory.js';
import type { RegistryEntry } from '../registry-rows.js';
import type { FieldGroupHandle } from '../setup/ChannelForms.js';
import {
  CAPABILITIES,
  capabilityState,
  neededCapabilities,
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
  /** The Setup step's Save and continue waits for a switch still running, and stays on a failure. */
  ref?: Ref<FieldGroupHandle>;
}): JSX.Element {
  const { principal, place } = props;
  const confirm = props.confirm ?? ((text: string) => window.confirm(text));
  const [lists, setLists] = useState<RegistryLists | null>(null);
  const [busy, setBusy] = useState<CapabilityId | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // The direction each capability was last switched, so a click on one left partly on (a
  // switch that stopped part way) finishes that, instead of reversing it.
  const [lastWanted, setLastWanted] = useState<Partial<Record<CapabilityId, boolean>>>({});
  const running = useRef<Promise<boolean> | null>(null);
  useImperativeHandle(props.ref, () => ({
    flush: async () => (running.current ? running.current : true),
  }));

  /** Re-reads the registry. Returns the failure, if any, so a flip's own message isn't lost. */
  const reload = useCallback(async (): Promise<string | null> => {
    try {
      setLists(await loadLists());
      return null;
    } catch (err) {
      return `Couldn’t read Curia’s capabilities: ${err instanceof Error ? err.message : 'unknown error'}`;
    }
  }, []);
  useEffect(() => {
    void reload().then((failure) => { if (failure) setMessage({ kind: 'error', text: failure }); });
  }, [reload]);

  function flip(cap: Capability, on: boolean): void {
    const p = runFlip(cap, on);
    running.current = p;
    void p.finally(() => { if (running.current === p) running.current = null; });
  }

  /** True when the switch finished (or was declined), false when it failed. */
  async function runFlip(cap: Capability, on: boolean): Promise<boolean> {
    if (!lists) return true;
    if (!on) {
      const warning = offWarning(cap, lists);
      if (warning && !confirm(warning)) return true;
    }
    // Turning on: what its agents pin from capabilities that are off is turned on first.
    const needs = on ? neededCapabilities(cap, lists) : [];
    const unavailable = needs.filter((n) => capabilityState(n, lists).kind === 'unavailable');
    if (unavailable.length > 0) {
      const names = unavailable.map((n) => n.label).join(' and ');
      setMessage({ kind: 'error', text: `Couldn’t turn ${cap.label} on: it needs ${names}, which ${unavailable.length > 1 ? 'aren’t' : 'isn’t'} available on this install.` });
      return false;
    }
    if (needs.length > 0) {
      const names = needs.map((n) => n.label).join(' and ');
      if (!confirm(`${cap.label} needs ${names}, which ${needs.length > 1 ? 'are' : 'is'} off. Turn ${needs.length > 1 ? 'them' : 'it'} on too?`)) return true;
    }
    setLastWanted((w) => ({ ...w, [cap.id]: on }));
    setBusy(cap.id);
    setMessage(null);
    let done = 0;
    const plan = [...needs.flatMap((n) => switchPlan(n, true, lists)), ...switchPlan(cap, on, lists)];
    let result: { kind: 'ok' | 'error'; text: string };
    try {
      // One at a time, in the plan's order, so a failure leaves the safe side of it done.
      for (const step of plan) {
        const res = await apiFetch(`/api/registry/${step.kind}/${encodeURIComponent(step.name)}/${step.action}`, { method: 'POST' });
        if (!res.ok) throw new Error(`${step.name}: ${await errorMessage(res)}`);
        done++;
      }
      const also = needs.length > 0 ? `, with ${needs.map((n) => n.label).join(' and ')}` : '';
      result = { kind: 'ok', text: `${cap.label} ${on ? 'on' : 'off'}${also}. ${restartNote(place)}` };
    } catch (err) {
      const text = err instanceof Error ? err.message : 'unknown error';
      result = {
        kind: 'error',
        text: done > 0
          ? `Couldn’t finish turning ${cap.label} ${on ? 'on' : 'off'} (${text}). Part of it changed; the switch shows where it is now.`
          : `Couldn’t turn ${cap.label} ${on ? 'on' : 'off'}: ${text}`,
      };
    }
    const failure = await reload();
    // The flip's outcome stays; a failed re-read is added to it, not put in its place. The
    // switches then show a state from before the flip, so they lock until a page reload.
    if (failure) setLists(null);
    setMessage(failure ? { kind: 'error', text: `${result.text} ${failure} Reload the page to see where things are.` } : result);
    setBusy(null);
    if (done > 0) props.onChanged?.();
    return result.kind === 'ok';
  }

  return (
    <div className="caps">
      {CAPABILITIES.map((cap) => {
        const state = lists ? capabilityState(cap, lists) : null;
        // The real state always: a lock only stops the switch, it never says something is on.
        const on = state?.kind === 'on';
        const lockedOff = cap.lock === 'principal-in-onboarding' && place === 'setup';
        const needs = lists && on ? neededCapabilities(cap, lists) : [];
        const fixed = state?.kind === 'unavailable'
          ? `Not available: ${state.missing.join(', ')} ${state.missing.length > 1 ? 'are' : 'is'} missing or broken${state.anyOn ? '. The rest is on' : ''}`
          : state?.kind === 'partly' ? 'Partly on'
          : needs.length > 0 ? `Needs ${needs.map((n) => n.label).join(' and ')}`
          : cap.lock === 'always-on' ? 'Always on'
          : lockedOff ? `Left for ${principal} to choose, later in Settings` : null;
        // Unavailable: only turning off what still runs is offered.
        const unavailableOff = state?.kind === 'unavailable' && state.anyOn;
        const disabled = !state || busy !== null || cap.lock === 'always-on' || lockedOff
          || (state.kind === 'unavailable' && !unavailableOff);
        // Partly on: finish the last attempt's direction (on, if there wasn't one here).
        const target = state?.kind === 'on' || unavailableOff ? false
          : state?.kind === 'partly' ? (lastWanted[cap.id] ?? true)
          : true;
        const mixed = state?.kind === 'partly' || unavailableOff;
        const descId = `cap-${cap.id}-desc`;
        const fixedId = `cap-${cap.id}-state`;
        return (
          <div className="cap" key={cap.id}>
            <div>
              <b>{cap.label}</b>
              <span className="cap-desc" id={descId}>{cap.description(principal)}</span>
            </div>
            {fixed && <span className="cap-fixed" id={fixedId}>{fixed}</span>}
            {/* A tri-state checkbox, drawn as a switch: role="switch" has no partly-on state. */}
            <button
              type="button"
              role="checkbox"
              className="cap-switch"
              aria-checked={mixed ? 'mixed' : on}
              aria-label={cap.label}
              aria-describedby={fixed ? `${fixedId} ${descId}` : descId}
              disabled={disabled}
              onClick={() => flip(cap, target)}
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
