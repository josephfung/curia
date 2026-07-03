import { describe, it, expect } from 'vitest';
import type { SceneDirective } from '@curia/shared-types';
import { agentIdsFromDirectives, buildDeskLayout, ensureAgentDesk } from './desk-layout.js';

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

  it('spawns a desk for a new agent id', () => {
    const base = buildDeskLayout([{ name: 'coordinator', metadata: { role: 'coordinator' } }], []);
    const extended = ensureAgentDesk(base, 'new-agent');
    expect(extended.some((s) => s.agentId === 'new-agent')).toBe(true);
  });
});
