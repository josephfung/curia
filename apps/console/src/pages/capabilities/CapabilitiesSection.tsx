// The Capabilities list (#2358 section 4), used in two places: the last optional extra on the
// Setup page, and Settings → Capabilities. One switch per capability; a switch flips every
// registry entry the capability covers through the existing /api/registry routes. Registry
// changes apply at the next restart.
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type JSX, type Ref } from 'react';
import { apiFetch } from '../../api.js';
import { errorMessage } from '../../components/settings/ConfigHistory.js';
import type { RegistryEntry } from '../registry-rows.js';
import type { FieldGroupHandle } from '../setup/ChannelForms.js';
import { fetchOnboardingStatus } from '../setup/start-onboarding.js';
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

/**
 * Whether onboarding holds Email triage (#2360). Only its label and what its switch does depend
 * on it, so a failed read doesn't hide the registry: it is logged, reads as not held, and the
 * section says so.
 */
async function loadTriageHeld(): Promise<{ held: boolean; error: string | null }> {
  try {
    return { held: (await fetchOnboardingStatus()).triageHeld === true, error: null };
  } catch (err) {
    console.error('[CapabilitiesSection] could not read the onboarding status:', err);
    const why = err instanceof Error ? err.message : 'unknown error';
    return { held: false, error: `Couldn’t read whether onboarding holds Email triage: ${why}` };
  }
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
  const [triageHeld, setTriageHeld] = useState(false);
  const [heldError, setHeldError] = useState<string | null>(null);
  const [busy, setBusy] = useState<CapabilityId | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // The direction each capability was last switched, so a click on one left partly on (a
  // switch that stopped part way) finishes that, instead of reversing it.
  const [lastWanted, setLastWanted] = useState<Partial<Record<CapabilityId, boolean>>>({});
  const running = useRef<Promise<boolean> | null>(null);
  // Capabilities whose last switch failed. Save and continue stays once on them, after the
  // request has finished too, and says so; pressed again it leaves them as they are, so a
  // failure that can't be fixed here (a missing key) never traps the step.
  const failed = useRef(new Set<CapabilityId>());
  useImperativeHandle(props.ref, () => ({
    flush: async () => {
      if (running.current) await running.current;
      if (failed.current.size === 0) return true;
      const names = CAPABILITIES.filter((c) => failed.current.has(c.id)).map((c) => c.label).join(' and ');
      failed.current.clear();
      setMessage((m) => ({
        kind: 'error',
        text: `${m?.kind === 'error' ? `${m.text} ` : ''}${names} didn’t switch. Try it again, or Save and continue again to leave it as it is.`,
      }));
      return false;
    },
  }));

  /** Re-reads the registry. Returns the failure, if any, so a flip's own message isn't lost. */
  const reload = useCallback(async (): Promise<string | null> => {
    try {
      const [next, held] = await Promise.all([loadLists(), loadTriageHeld()]);
      setLists(next);
      setTriageHeld(held.held);
      setHeldError(held.error);
      return null;
    } catch (err) {
      return `Couldn’t read Curia’s capabilities: ${err instanceof Error ? err.message : 'unknown error'}`;
    }
  }, []);
  useEffect(() => {
    void reload().then((failure) => { if (failure) setMessage({ kind: 'error', text: failure }); });
  }, [reload]);

  function flip(cap: Capability, on: boolean): void {
    const p = runFlip(cap, on).then((ok) => {
      // null: declined or not loaded, so nothing changed and an earlier failure stands.
      if (ok === true) failed.current.delete(cap.id);
      if (ok === false) failed.current.add(cap.id);
      return ok !== false;
    });
    running.current = p;
    void p.finally(() => { if (running.current === p) running.current = null; });
  }

  /** True when the switch finished, false when it failed, null when declined or not loaded. */
  async function runFlip(cap: Capability, on: boolean): Promise<boolean | null> {
    if (!lists) return null;
    if (!on) {
      const warning = offWarning(cap, lists);
      if (warning && !confirm(warning)) return null;
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
      if (!confirm(`${cap.label} needs ${names}, which ${needs.length > 1 ? 'are' : 'is'} off. Turn ${needs.length > 1 ? 'them' : 'it'} on too?`)) return null;
    }
    setLastWanted((w) => ({ ...w, [cap.id]: on }));
    setBusy(cap.id);
    setMessage(null);
    let done = 0;
    const plan = [...needs.flatMap((n) => switchPlan(n, true, lists)), ...switchPlan(cap, on, lists)];
    // Switching held Email triage on releases the hold first: that part is live, no restart.
    const release = cap.id === 'triage' && on && triageHeld;
    let result: { kind: 'ok' | 'error'; text: string };
    try {
      if (release) {
        const res = await apiFetch('/api/onboarding/triage-hold', { method: 'DELETE' });
        if (!res.ok) throw new Error(`the hold: ${await errorMessage(res)}`);
        done++;
      }
      // One at a time, in the plan's order, so a failure leaves the safe side of it done.
      for (const step of plan) {
        const res = await apiFetch(`/api/registry/${step.kind}/${encodeURIComponent(step.name)}/${step.action}`, { method: 'POST' });
        if (!res.ok) throw new Error(`${step.name}: ${await errorMessage(res)}`);
        done++;
      }
      const also = needs.length > 0 ? `, with ${needs.map((n) => n.label).join(' and ')}` : '';
      const note = plan.length > 0 ? ` ${restartNote(place)}` : '';
      result = { kind: 'ok', text: `${cap.label} ${on ? 'on' : 'off'}${also}.${note}` };
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
        const held = cap.id === 'triage' && triageHeld;
        // Held: on in the registry, but doing nothing yet, so the switch reads off and turns it on.
        const on = state?.kind === 'on' && !held;
        const lockedOff = cap.lock === 'principal-in-onboarding' && place === 'setup';
        const needs = lists && on ? neededCapabilities(cap, lists) : [];
        const fixed = state?.kind === 'unavailable'
          ? `Not available: ${state.missing.join(', ')} ${state.missing.length > 1 ? 'are' : 'is'} missing or broken${state.anyOn ? '. The rest is on' : ''}`
          : held ? `Held until ${principal} hears what to expect`
          : state?.kind === 'partly' ? 'Partly on'
          : needs.length > 0 ? `Needs ${needs.map((n) => n.label).join(' and ')}`
          : cap.lock === 'always-on' ? 'Always on'
          : lockedOff ? `Left for ${principal} to choose, later in Settings` : null;
        // Unavailable: only turning off what still runs is offered.
        const unavailableOff = state?.kind === 'unavailable' && state.anyOn;
        const disabled = !state || busy !== null || cap.lock === 'always-on' || lockedOff
          || (state.kind === 'unavailable' && !unavailableOff);
        // Partly on: finish the last attempt's direction (on, if there wasn't one here).
        const target = unavailableOff ? false
          : held ? true
          : state?.kind === 'on' ? false
          : state?.kind === 'partly' ? (lastWanted[cap.id] ?? true)
          : true;
        const mixed = (state?.kind === 'partly' && !held) || unavailableOff;
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
      {heldError && <p className="setup-status attention" role="alert">{heldError}</p>}
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
