import { describe, it, expect, vi } from 'vitest';
import type { SceneDirective } from '@curia/shared-types';
import { agentIdsFromDirectives, agentRosterKey, buildDeskLayout, deskLayoutKey, ensureAgentDesk, parseRegistryAgents } from './desk-layout.js';

describe('desk layout', () => {
  it('places coordinator in the boss row and others on the floor', () => {
    const layout = buildDeskLayout(
      [
        { name: 'coordinator', metadata: { role: 'coordinator' } },
        { name: 'research', metadata: { role: 'specialist' } },
        { name: 'calendar', metadata: { role: 'specialist' } },
      ],
      [],
    );
    expect(layout.find((s) => s.agentId === 'coordinator')?.row).toBe('boss');
    expect(layout.filter((s) => s.row === 'floor')).toHaveLength(2);
  });

  it('includes unseen agent ids from directives on demand', () => {
    const directives = [{
      id: '1',
      logicalTs: 0,
      causedBy: null,
      kind: 'agent.walk',
      agentId: 'coordinator',
      targetAgentId: 'custom-bot',
    }] as SceneDirective[];

    const layout = buildDeskLayout([], agentIdsFromDirectives(directives));
    expect(layout.some((s) => s.agentId === 'custom-bot')).toBe(true);
  });

  it('never mints a desk for a non-agent room/channel (e.g. the bullpen)', () => {
    const directives = [{
      id: '1',
      logicalTs: 0,
      causedBy: null,
      kind: 'agent.walk',
      agentId: 'coordinator',
      targetAgentId: 'bullpen',
    }] as SceneDirective[];

    // The delegation target is a room — it must not appear in the derived ids, the desk layout,
    // or via ensureAgentDesk.
    const ids = agentIdsFromDirectives(directives);
    expect(ids.has('bullpen')).toBe(false);

    const layout = buildDeskLayout([{ name: 'coordinator', metadata: { role: 'coordinator' } }], ['bullpen']);
    expect(layout.some((s) => s.agentId === 'bullpen')).toBe(false);
    expect(ensureAgentDesk(layout, 'bullpen').some((s) => s.agentId === 'bullpen')).toBe(false);
  });

  it('spawns a desk for a new agent id', () => {
    const base = buildDeskLayout([{ name: 'coordinator', metadata: { role: 'coordinator' } }], []);
    const extended = ensureAgentDesk(base, 'new-agent');
    expect(extended.some((s) => s.agentId === 'new-agent')).toBe(true);
  });

  it('agentRosterKey is stable when directive order changes', () => {
    const registry = [{ name: 'coordinator', metadata: { role: 'coordinator' } }];
    const a = agentRosterKey(registry, ['calendar', 'research']);
    const b = agentRosterKey(registry, ['research', 'calendar']);
    expect(a).toBe(b);
  });

  it('deskLayoutKey ignores desk array identity', () => {
    const desks = [
      { agentId: 'coordinator', row: 'boss' as const, column: 0 },
      { agentId: 'calendar', row: 'floor' as const, column: 0 },
    ];
    expect(deskLayoutKey(desks)).toBe(deskLayoutKey([...desks]));
  });
});

describe('parseRegistryAgents', () => {
  it('returns well-formed agents unchanged', () => {
    const onWarn = vi.fn();
    const agents = parseRegistryAgents(
      { agents: [{ name: 'coordinator', metadata: { role: 'coordinator' } }, { name: 'research' }] },
      onWarn,
    );
    expect(agents).toEqual([
      { name: 'coordinator', metadata: { role: 'coordinator' } },
      { name: 'research' },
    ]);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('accepts null or absent metadata', () => {
    expect(parseRegistryAgents({ agents: [{ name: 'a', metadata: null }, { name: 'b' }] })).toHaveLength(2);
  });

  it('degrades to an empty roster and warns when "agents" is not an array', () => {
    const onWarn = vi.fn();
    expect(parseRegistryAgents({ agents: 'nope' }, onWarn)).toEqual([]);
    expect(parseRegistryAgents(null, onWarn)).toEqual([]);
    expect(parseRegistryAgents('garbage', onWarn)).toEqual([]);
    expect(onWarn).toHaveBeenCalledTimes(3);
  });

  it('drops malformed entries, keeps valid ones, and warns about the drop', () => {
    const onWarn = vi.fn();
    const agents = parseRegistryAgents(
      { agents: [{ name: 'ok' }, { name: 42 }, null, { role: 'no-name' }, { name: 'ok2' }] },
      onWarn,
    );
    expect(agents).toEqual([{ name: 'ok' }, { name: 'ok2' }]);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('dropped 3'));
  });

  it('does not throw when fed to buildDeskLayout after parsing junk', () => {
    const agents = parseRegistryAgents({ agents: [{ bogus: true }, 7, 'x'] });
    expect(() => buildDeskLayout(agents, [])).not.toThrow();
  });
});
