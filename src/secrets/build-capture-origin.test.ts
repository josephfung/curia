// build-capture-origin.test.ts — shared capture-origin builder for the secret-capture skills (#995).
import { describe, it, expect } from 'vitest';
import { buildCaptureOrigin } from './build-capture-origin.js';
import { decodeResumeToken } from '../agents/resume-token.js';
import type { SkillContext } from '../skills/types.js';

function ctx(over: Partial<SkillContext> = {}): SkillContext {
  return {
    conversationId: 'own-conv',
    channelId: 'internal',
    agentId: 'accounts-specialist',
    taskEventId: 'evt-1',
    ...over,
  } as unknown as SkillContext;
}

describe('buildCaptureOrigin (#995)', () => {
  it("returns the agent's own routing and no resume_token when not delegated", () => {
    const origin = buildCaptureOrigin(
      ctx({ conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator' }),
      'check the balance',
    );
    expect(origin.conversationId).toBe('user-conv');
    expect(origin.channelId).toBe('email');
    expect(origin.agentId).toBe('coordinator');
    expect(origin.taskEventId).toBe('evt-1');
    expect(origin.resumeIntent).toBe('check the balance');
    expect(origin).not.toHaveProperty('resumeToken');
  });

  it('retargets at the coordinator and mints a resume_token when delegated', () => {
    const originator = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' };
    const origin = buildCaptureOrigin(
      ctx({
        conversationId: 'delegate-xyz',
        channelId: 'internal',
        agentId: 'accounts-specialist',
        taskMetadata: {
          originator,
          delegationOrigin: { conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator', originalTask: 'log into Aeroplan and check balance' },
        },
      }),
      'check the balance',
    );
    expect(origin.conversationId).toBe('user-conv');
    expect(origin.channelId).toBe('email');
    expect(origin.agentId).toBe('coordinator');
    expect(origin.originator).toEqual(originator);
    // The coordinator's task id isn't threaded; subscriber falls back to the event id.
    expect(origin.taskEventId).toBeUndefined();
    const decoded = decodeResumeToken(origin.resumeToken!)!;
    expect(decoded.agent).toBe('accounts-specialist');
    expect(decoded.original_task).toBe('log into Aeroplan and check balance');
    expect(decoded.context).toBe('check the balance');
  });

  it('falls back to own routing when delegationOrigin is incomplete (missing channelId)', () => {
    const origin = buildCaptureOrigin(
      ctx({
        conversationId: 'delegate-xyz',
        channelId: 'internal',
        agentId: 'accounts-specialist',
        taskMetadata: { delegationOrigin: { conversationId: 'user-conv', agentId: 'coordinator', originalTask: 'x' } },
      }),
      'intent',
    );
    expect(origin.channelId).toBe('internal');
    expect(origin).not.toHaveProperty('resumeToken');
  });
});
