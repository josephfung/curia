// The person-turn side of identifier provenance (#2061): what of a stored turn a person wrote.
import { describe, it, expect, vi } from 'vitest';
import { personTurnSourceText, createIdentifierSources } from '../../../src/agents/identifier-sources.js';
import { IdentifierSourceIndex } from '../../../src/agents/identifier-source-index.js';
import { WorkingMemory } from '../../../src/memory/working-memory.js';
import { createLogger } from '../../../src/logger.js';

describe('personTurnSourceText', () => {
  it('drops an outbound-context block that has no terminator, and everything after it', () => {
    const text = personTurnSourceText("hi sam@venue.example\n[ACTIVE OUTBOUND CONTEXT — x]\npreview: \"cc lee@venu.example\"");
    expect(text).toContain('sam@venue.example');
    expect(text).not.toContain('lee@venu.example');
  });

  it('cuts quoted history in the common client formats', () => {
    for (const quote of [
      'On Tue, Oct 7, 2026 at 3:00 PM Curia <curia@office.example> wrote:\nI will cc rob@venu.example',
      '-----Original Message-----\nFrom: Curia\nI will cc rob@venu.example',
      'From: Curia <curia@office.example>\nSent: Tuesday\nI will cc rob@venu.example',
    ]) {
      const text = personTurnSourceText(`Add lee@venue.example please.\n\n${quote}`);
      expect(text).toContain('lee@venue.example');
      expect(text).not.toContain('rob@venu.example');
    }
  });

  it('drops >-quoted lines', () => {
    expect(personTurnSourceText('ok\n> cc rob@venu.example\nthanks')).not.toContain('rob@venu.example');
  });
});

describe('createIdentifierSources', () => {
  it('reads person turns once per task', async () => {
    const memory = WorkingMemory.createInMemory();
    await memory.addTurn('conv', 'coordinator', { role: 'user', content: 'email sam@venue.example' }, { channelId: 'cli' });
    const read = vi.spyOn(memory, 'getPersonTurns');
    const sources = createIdentifierSources({
      index: new IdentifierSourceIndex(),
      sourceConversation: 'conv',
      personTurns: { conversationId: 'conv', agentId: 'coordinator' },
      memory,
      logger: createLogger('error'),
    });
    await expect(sources.has('email', 'sam@venue.example')).resolves.toBe(true);
    await expect(sources.has('email', 'lee@venue.example')).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
