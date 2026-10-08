// Seeds one conversation with a turn of every kind, for WorkingMemory.getPersonTurns
// (#2061). Shared by the in-memory unit test and the Postgres integration test so the
// two backends are held to the same answer.
import type { WorkingMemory } from '../../src/memory/working-memory.js';

export const PERSON_TURN_CONTENTS = ['email sam@venue-co.com', 'Re: the venue — their desk is +1 416 555 0100'];

export async function seedPersonTurnConversation(memory: WorkingMemory, conversationId: string, agentId: string): Promise<void> {
  const add = (role: 'user' | 'assistant', content: string, meta: Parameters<WorkingMemory['addTurn']>[3]) =>
    memory.addTurn(conversationId, agentId, { role, content }, meta);
  await add('user', PERSON_TURN_CONTENTS[0]!, { channelId: 'cli' });
  await add('assistant', 'Curia wrote sam@venu-co.com', { channelId: 'cli' });
  await add('user', 'delegation brief lee@venue-co.com', { channelId: 'internal' });
  await add('user', 'bullpen post lee@venue-co.com', { channelId: 'bullpen' });
  await add('user', 'scheduled payload lee@venue-co.com', { channelId: 'scheduler' });
  await add('user', 'late specialist result lee@venue-co.com', { channelId: 'cli', synthetic: true });
  await add('user', 'unattributed lee@venue-co.com', {});
  await add('user', PERSON_TURN_CONTENTS[1]!, { channelId: 'email' });
}
