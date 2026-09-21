import { describe, it, expect } from 'vitest';
import { ConversationEntityState } from '../../../src/entity-context/conversation-entities.js';
import type { ResolvedEntityCard } from '../../../src/agents/resolved-entities.js';

const XIAOPU = '11111111-1111-4111-8111-111111111111';

function card(displayName: string): ResolvedEntityCard {
  return {
    contactId: XIAOPU,
    displayName,
    preferredName: null,
    role: 'Spouse',
    organization: null,
    primaryEmail: 'xiaopu@example.com',
    primaryPhone: null,
  };
}

describe('ConversationEntityState', () => {
  it('re-reads the current card instead of the name captured at resolution', async () => {
    let current = card('Xiaopu Fung');
    const state = ConversationEntityState.createInMemory(
      { get: (id) => (id === XIAOPU ? current : undefined) },
      ['Joseph Fung'],
    );

    const stored = await state.record('conv-1', 'coordinator', [XIAOPU, 'not-a-uuid']);
    expect(stored.map(c => c.displayName)).toEqual(['Xiaopu Fung']);

    current = card('Xiaopu Chen');
    const loaded = await state.loadCurrent('conv-1', 'coordinator');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.displayName).toBe('Xiaopu Chen');
    expect(loaded[0]!.primaryEmail).toBe('xiaopu@example.com');
  });

  it('keeps the turn registry separate from the durable store', async () => {
    const current = card('Xiaopu Fung');
    const state = ConversationEntityState.createInMemory(
      { get: () => current },
    );
    state.turnIdentities.begin('task-1');
    expect(state.turnIdentities.has('task-1')).toBe(true);
    const fresh = await state.record('conv-1', 'coordinator', [XIAOPU]);
    state.turnIdentities.merge('task-1', fresh);
    expect(state.turnIdentities.get('task-1').map(c => c.contactId)).toEqual([XIAOPU]);
    state.turnIdentities.end('task-1');
    expect(state.turnIdentities.has('task-1')).toBe(false);
    expect(await state.loadCurrent('conv-1', 'coordinator')).toHaveLength(1);
  });
});
