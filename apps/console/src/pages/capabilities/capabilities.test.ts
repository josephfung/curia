// Capabilities (#2358 section 4): a capability's state, the order its entries switch in, and
// the warning before turning off what other agents use.
import { describe, it, expect } from 'vitest';
import type { RegistryEntry } from '../registry-rows.js';
import { CAPABILITIES, capabilityState, neededCapabilities, offWarning, outsidePins, switchPlan } from './capabilities.js';

/** RegistryLists, but editable, so a test can vary one entry. */
interface Lists { agents: RegistryEntry[]; skills: RegistryEntry[]; tools: RegistryEntry[] }

function entry(kind: RegistryEntry['kind'], name: string, state: RegistryEntry['state'], meta: Partial<NonNullable<RegistryEntry['metadata']>> = {}): RegistryEntry {
  return {
    name, kind, state, installedAt: null, installedBy: null, enabledAt: null, enabledBy: null,
    metadata: { name, description: '', version: '0.1.0', ...meta },
  };
}

const cap = (id: string) => CAPABILITIES.find((c) => c.id === id)!;

function lists(over: { research?: RegistryEntry['state']; web?: RegistryEntry['state']; coordinatorPinsWeb?: boolean } = {}): Lists {
  return {
    agents: [
      entry('agent', 'research-analyst', over.research ?? 'enabled', { pinnedTools: ['web-search', 'web-fetch'] }),
      entry('agent', 'coordinator', 'enabled', { pinnedTools: over.coordinatorPinsWeb === false ? ['tasks'] : ['web', 'tasks'] }),
      entry('agent', 'contacts', 'enabled', { pinnedTools: ['tasks'] }),
      entry('agent', 'diagnostics', 'installed', { pinnedTools: ['diagnostics'] }),
    ],
    skills: [
      entry('skill', 'web', over.web ?? 'enabled', { tools: ['web-search', 'web-fetch'] }),
      entry('skill', 'tasks', 'enabled', { tools: ['task-create'] }),
      entry('skill', 'diagnostics', 'uninstalled', { tools: ['audit-query'] }),
    ],
    tools: [],
  };
}

describe('the catalog', () => {
  it('lists the six capabilities, Meetings locked on and Email triage off in Setup', () => {
    expect(CAPABILITIES.map((c) => c.id)).toEqual(['meetings', 'debriefs', 'research', 'tasks', 'diagnostics', 'triage']);
    expect(cap('meetings').lock).toBe('always-on');
    expect(cap('triage').lock).toBe('principal-in-onboarding');
    expect(cap('research').description('Dana')).toContain('research analyst');
  });
});

describe('capabilityState', () => {
  it('is on, off or partly, from every entry it covers', () => {
    expect(capabilityState(cap('research'), lists())).toEqual({ kind: 'on' });
    expect(capabilityState(cap('research'), lists({ research: 'installed', web: 'installed' }))).toEqual({ kind: 'off' });
    expect(capabilityState(cap('research'), lists({ research: 'installed' }))).toEqual({ kind: 'partly', off: ['research-analyst'] });
  });

  it('is unavailable when the server lacks an entry or its manifest is broken', () => {
    expect(capabilityState(cap('debriefs'), lists())).toEqual({ kind: 'unavailable', missing: ['meeting-debrief'], anyOn: false });
    const broken = lists();
    broken.skills[0] = { ...broken.skills[0]!, manifestError: 'bad yaml' };
    expect(capabilityState(cap('research'), broken)).toEqual({ kind: 'unavailable', missing: ['web'], anyOn: true });
  });

  it('counts a tool on inside a readable bundle as on, when the rest is missing or off', () => {
    // research-analyst missing, web disabled, web-search on alone: the switch can still turn it off.
    const l = lists({ web: 'installed' });
    l.agents = l.agents.filter((a) => a.name !== 'research-analyst');
    l.tools = [entry('tool', 'web-search', 'enabled'), entry('tool', 'web-fetch', 'installed')];
    expect(capabilityState(cap('research'), l)).toEqual({ kind: 'unavailable', missing: ['research-analyst'], anyOn: true });
    expect(switchPlan(cap('research'), false, l)).toEqual([{ kind: 'tools', name: 'web-search', action: 'disable' }]);
  });

  it('is partly on when a tool inside an enabled bundle was turned off alone', () => {
    const l = lists();
    l.tools = [entry('tool', 'web-search', 'installed'), entry('tool', 'web-fetch', 'enabled')];
    expect(capabilityState(cap('research'), l)).toEqual({ kind: 'partly', off: ['web-search'] });
  });

  it('is partly on when a tool was turned on alone under a disabled bundle', () => {
    const l = lists({ research: 'installed', web: 'installed' });
    l.tools = [entry('tool', 'web-search', 'enabled'), entry('tool', 'web-fetch', 'installed')];
    expect(capabilityState(cap('research'), l)).toEqual({ kind: 'partly', off: ['web', 'research-analyst'] });
    l.tools[0] = entry('tool', 'web-search', 'installed');
    expect(capabilityState(cap('research'), l)).toEqual({ kind: 'off' });
  });
});

describe('switchPlan', () => {
  it('turns on what it pins before the agent, and only what is off', () => {
    expect(switchPlan(cap('diagnostics'), true, lists())).toEqual([
      { kind: 'skills', name: 'diagnostics', action: 'install-enable' },
      { kind: 'agents', name: 'diagnostics', action: 'install-enable' },
    ]);
  });

  it('turns the agent off before what it pins, skipping what is already off', () => {
    expect(switchPlan(cap('research'), false, lists())).toEqual([
      { kind: 'agents', name: 'research-analyst', action: 'disable' },
      { kind: 'skills', name: 'web', action: 'disable' },
    ]);
    expect(switchPlan(cap('diagnostics'), false, lists())).toEqual([]);
  });

  it('enables a bundle again when one of its tools was turned off alone', () => {
    const l = lists();
    l.tools = [entry('tool', 'web-search', 'installed'), entry('tool', 'web-fetch', 'enabled')];
    expect(switchPlan(cap('research'), true, l)).toEqual([{ kind: 'skills', name: 'web', action: 'install-enable' }]);
  });

  it('turns off a tool left on alone under a disabled bundle', () => {
    const l = lists({ research: 'installed', web: 'installed' });
    l.tools = [entry('tool', 'web-search', 'enabled'), entry('tool', 'web-fetch', 'installed')];
    expect(switchPlan(cap('research'), false, l)).toEqual([{ kind: 'tools', name: 'web-search', action: 'disable' }]);
  });
});

describe('outsidePins and the warning', () => {
  it('names enabled agents outside the capability that pin its bundles', () => {
    expect(outsidePins(cap('research'), lists())).toEqual([{ agent: 'coordinator', loses: 'web' }]);
    expect(outsidePins(cap('tasks'), lists())).toEqual([
      { agent: 'coordinator', loses: 'tasks' },
      { agent: 'contacts', loses: 'tasks' },
    ]);
    expect(offWarning(cap('research'), lists())).toContain('• coordinator also uses web');
  });

  it('counts a bundle tool an outside agent pins directly, and ignores the capability’s own agents', () => {
    const l = lists({ coordinatorPinsWeb: false });
    l.agents.push(entry('agent', 'calendar', 'enabled', { pinnedTools: ['web-fetch'] }));
    expect(outsidePins(cap('research'), l)).toEqual([{ agent: 'calendar', loses: 'web-fetch' }]);
  });

  it('has nothing to warn about when no other agent uses it, or the other agent is off', () => {
    expect(offWarning(cap('diagnostics'), lists())).toBeNull();
    const l = lists();
    l.agents = l.agents.map((a) => (a.name === 'coordinator' ? { ...a, state: 'installed' as const } : a));
    expect(offWarning(cap('research'), l)).toBeNull();
  });
});

describe('neededCapabilities', () => {
  it('names an off capability whose tools the agent pins, by bundle or tool by tool', () => {
    const l = lists();
    l.agents.push(entry('agent', 'meeting-debrief', 'installed', { pinnedTools: ['task-create'] }));
    l.agents.push(entry('agent', 'ceo-inbox', 'installed', { pinnedTools: ['tasks', 'ceo-inbox'] }));
    expect(neededCapabilities(cap('debriefs'), l)).toEqual([]);
    l.skills[1] = { ...l.skills[1]!, state: 'installed' };
    expect(neededCapabilities(cap('debriefs'), l).map((c) => c.id)).toEqual(['tasks']);
    // Its own bundles don't count.
    expect(neededCapabilities(cap('triage'), l).map((c) => c.id)).toEqual(['tasks']);
    expect(neededCapabilities(cap('research'), l)).toEqual([]);
  });

  it('keeps the catalog’s needs when a bundle’s manifest can’t be read, and names it unavailable', () => {
    const l = lists();
    l.agents.push(entry('agent', 'meeting-debrief', 'installed', { pinnedTools: ['task-create'] }));
    l.skills[1] = { ...l.skills[1]!, metadata: null, manifestError: 'bad yaml' };
    const needs = neededCapabilities(cap('debriefs'), l);
    expect(needs.map((c) => c.id)).toEqual(['tasks']);
    expect(capabilityState(needs[0]!, l).kind).toBe('unavailable');
  });
});
