import { describe, it, expect } from 'vitest';
import type { SceneDirective } from '@curia/shared-types';
import { agentIdsFromDirectives, agentRosterKey, buildDeskLayout, deskLayoutKey, ensureAgentDesk } from './desk-layout.js';

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
