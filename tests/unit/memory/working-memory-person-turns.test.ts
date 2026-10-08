import { describe, it, expect } from 'vitest';
import { WorkingMemory } from '../../../src/memory/working-memory.js';
import { PERSON_TURN_CONTENTS, seedPersonTurnConversation } from '../../helpers/person-turns-fixture.js';

describe('WorkingMemory.getPersonTurns (in-memory, #2061)', () => {
  it('returns only the user turns a person sent, newest first', async () => {
    const memory = WorkingMemory.createInMemory();
    await seedPersonTurnConversation(memory, 'conv-person', 'coordinator');
    await expect(memory.getPersonTurns('conv-person', 'coordinator')).resolves.toEqual([...PERSON_TURN_CONTENTS].reverse());
  });

  it('is scoped to the conversation and agent', async () => {
    const memory = WorkingMemory.createInMemory();
    await seedPersonTurnConversation(memory, 'conv-person', 'coordinator');
    await expect(memory.getPersonTurns('conv-person', 'contacts')).resolves.toEqual([]);
    await expect(memory.getPersonTurns('conv-other', 'coordinator')).resolves.toEqual([]);
  });
});
