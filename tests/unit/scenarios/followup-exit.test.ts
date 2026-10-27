import { describe, expect, it } from 'vitest';
import type { BusEvent } from '../../../src/bus/events.js';
import { isTextFinishCall, publishFollowupOnTextFinish, turnStartDrainError, type TextFinishSlot } from '../../scenarios/followup-exit.js';

function llmCall(response: unknown): BusEvent {
  return {
    type: 'llm.call',
    archive: { prompt: {}, response, toolDefinitions: [] },
  } as BusEvent;
}

describe('isTextFinishCall', () => {
  it('is true only for a text llm.call, the step before the exit hook', () => {
    expect(isTextFinishCall(llmCall({ type: 'text', content: 'ask for the code' }))).toBe(true);
    expect(isTextFinishCall(llmCall({ type: 'tool_use', toolCalls: [] }))).toBe(false);
    expect(isTextFinishCall(llmCall(null))).toBe(false);
    expect(isTextFinishCall(llmCall('text'))).toBe(false);
    expect(isTextFinishCall({ type: 'agent.response' } as BusEvent)).toBe(false);
  });
});

function textFinish(agentId = 'coordinator'): BusEvent {
  return {
    type: 'llm.call',
    archive: { prompt: {}, response: { type: 'text', content: 'the code is in your email' }, toolDefinitions: [] },
    payload: { conversationId: 'c1', agentId },
  } as BusEvent;
}

describe('publishFollowupOnTextFinish', () => {
  function slot(publish: () => Promise<void>, claim: () => boolean = () => true): Map<string, TextFinishSlot> {
    return new Map([['c1', { agentId: 'coordinator', claim, publish }]]);
  }

  it('publishes once on a text finish, and an exit drain is not a failure', async () => {
    const published: string[] = [];
    let claims = 0;
    const slots = slot(async () => { published.push('follow-up'); }, () => {
      claims += 1;
      return claims === 1;
    });
    const failures: string[] = [];
    await publishFollowupOnTextFinish(textFinish(), slots, (id) => { failures.push(id); });
    await publishFollowupOnTextFinish(textFinish(), slots, (id) => { failures.push(id); });
    const toolUse = textFinish();
    if (toolUse.type === 'llm.call' && toolUse.archive) toolUse.archive.response = { type: 'tool_use', toolCalls: [] };
    await publishFollowupOnTextFinish(toolUse, slots, (id) => { failures.push(id); });
    await publishFollowupOnTextFinish(textFinish('someone-else'), slots, (id) => { failures.push(id); });
    expect(published).toEqual(['follow-up']);
    expect(failures).toEqual([]);
    expect(turnStartDrainError('exit')).toBeUndefined();
    expect(turnStartDrainError('turn_start')).toMatch(/turn_start/);
  });

  it('records a publish failure on the run instead of swallowing it', async () => {
    const failures: unknown[] = [];
    await publishFollowupOnTextFinish(
      textFinish(),
      slot(async () => { throw new Error('queue missed'); }),
      (_id, err) => { failures.push(err); },
    );
    expect(failures).toEqual([new Error('queue missed')]);
  });
});

describe('turnStartDrainError', () => {
  it('fails a turn_start drain and leaves a later point alone', () => {
    expect(turnStartDrainError('turn_start')).toBe(
      'follow-up drained at turn_start; the correction joined before the model had chosen',
    );
    expect(turnStartDrainError('exit')).toBeUndefined();
    expect(turnStartDrainError('round:1')).toBeUndefined();
  });
});
