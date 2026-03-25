import { describe, it, expect, beforeEach } from 'vitest';
import { WorkingMemory } from '../../../src/memory/working-memory.js';

describe('WorkingMemory', () => {
  let memory: WorkingMemory;

  beforeEach(() => {
    memory = WorkingMemory.createInMemory();
  });

  it('stores and retrieves conversation turns', async () => {
    await memory.addTurn('conv-1', 'coordinator', { role: 'user', content: 'Hello' });
    await memory.addTurn('conv-1', 'coordinator', { role: 'assistant', content: 'Hi there!' });

    const history = await memory.getHistory('conv-1', 'coordinator');
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe('user');
    expect(history[1]?.role).toBe('assistant');
  });

  it('returns empty array for unknown conversation', async () => {
    const history = await memory.getHistory('unknown', 'coordinator');
    expect(history).toEqual([]);
  });

  it('keeps conversations separate', async () => {
    await memory.addTurn('conv-1', 'coordinator', { role: 'user', content: 'First' });
    await memory.addTurn('conv-2', 'coordinator', { role: 'user', content: 'Second' });

    const h1 = await memory.getHistory('conv-1', 'coordinator');
    const h2 = await memory.getHistory('conv-2', 'coordinator');
    expect(h1).toHaveLength(1);
    expect(h2).toHaveLength(1);
    expect(h1[0]?.content).toBe('First');
    expect(h2[0]?.content).toBe('Second');
  });

  it('limits returned history to maxTurns', async () => {
    for (let i = 0; i < 25; i++) {
      await memory.addTurn('conv-1', 'coordinator', { role: 'user', content: `Message ${i}` });
    }

    const history = await memory.getHistory('conv-1', 'coordinator', { maxTurns: 10 });
    expect(history).toHaveLength(10);
    // Should be the LAST 10 (most recent), in chronological order
    expect(history[0]?.content).toBe('Message 15');
    expect(history[9]?.content).toBe('Message 24');
  });
});
