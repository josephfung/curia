// handler.test.ts — delegate skill: forwarding of relay context for specialist resume (#995).
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { DelegateHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { BusEvent, AgentTaskEvent } from '../../src/bus/events.js';
import { createAgentResponse } from '../../src/bus/events.js';
import { encodeResumeToken } from '../../src/agents/resume-token.js';

/** Fake bus that, when an agent.task is published, immediately delivers a successful
 *  agent.response parented to it so DelegateHandler's await resolves. */
function makeBus() {
  const published: BusEvent[] = [];
  const responseHandlers: Array<(e: BusEvent) => unknown> = [];
  const bus = {
    subscribe(type: string, _layer: string, handler: (e: BusEvent) => unknown) {
      if (type === 'agent.response') responseHandlers.push(handler);
    },
    async publish(_layer: string, event: BusEvent) {
      published.push(event);
      if (event.type === 'agent.task') {
        const task = event as AgentTaskEvent;
        const resp = createAgentResponse({
          agentId: task.payload.agentId,
          conversationId: task.payload.conversationId,
          content: 'done',
          skillsCalled: [],
          parentEventId: task.id,
        });
        for (const h of responseHandlers) await h(resp);
      }
    },
  } as unknown as EventBus;
  return { bus, published };
}

const agentRegistry = {
  has: (n: string) => n === 'research-analyst',
  get: (n: string) => ({ name: n, role: 'specialist' }),
  listSpecialists: () => [{ name: 'research-analyst' }],
} as unknown as SkillContext['agentRegistry'];

function makeCtx(bus: EventBus, over: Partial<SkillContext> = {}): SkillContext {
  return {
    input: { agent: 'research-analyst', task: 'find the acquisition comps' },
    log: pino({ level: 'silent' }),
    bus,
    agentRegistry,
    agentId: 'coordinator',
    conversationId: 'user-conv',
    channelId: 'email',
    taskMetadata: { originator: { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' } },
    ...over,
  } as unknown as SkillContext;
}

describe('DelegateHandler relay-context forwarding (#995)', () => {
  it('forwards delegationOrigin (coordinator routing + brief) and originator on the specialist task', async () => {
    const { bus, published } = makeBus();
    const result = await new DelegateHandler().execute(makeCtx(bus));
    expect(result.success).toBe(true);

    const task = published.find(e => e.type === 'agent.task');
    expect(task).toBeDefined();
    expect((task as AgentTaskEvent).payload.metadata).toMatchObject({
      delegationOrigin: {
        conversationId: 'user-conv',
        channelId: 'email',
        agentId: 'coordinator',
        originalTask: 'find the acquisition comps',
      },
      originator: { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' },
    });
  });

  it('forwards delegationOrigin without originator when no originator is in ctx', async () => {
    const { bus, published } = makeBus();
    const result = await new DelegateHandler().execute(
      makeCtx(bus, { taskMetadata: undefined }),
    );
    expect(result.success).toBe(true);

    const task = published.find(e => e.type === 'agent.task');
    expect(task).toBeDefined();
    expect((task as AgentTaskEvent).payload.metadata).toMatchObject({
      delegationOrigin: {
        conversationId: 'user-conv',
        channelId: 'email',
        agentId: 'coordinator',
        originalTask: 'find the acquisition comps',
      },
    });
    expect((task as AgentTaskEvent).payload.metadata).not.toHaveProperty('originator');
  });

  it('forwards the live-principal-turn signal across a synchronous delegation (#1126)', async () => {
    // The crux of #1126's delegated-elevated support: a specialist delegated-to inside the CEO's
    // live turn inherits liveTurn, so it can satisfy the elevated gate (e.g. contact-set-tier).
    const { bus, published } = makeBus();
    const result = await new DelegateHandler().execute(makeCtx(bus, { liveTurn: true }));
    expect(result.success).toBe(true);

    const task = published.find(e => e.type === 'agent.task') as AgentTaskEvent;
    // liveTurn is a DISTINCT payload field, not a metadata-bag key — so it cannot be persisted.
    expect(task.payload.liveTurn).toBe(true);
    expect(task.payload.metadata).not.toHaveProperty('liveTurn');
  });

  it('does NOT forward a live signal when the delegating turn is not live', async () => {
    // An autonomous/woken coordinator turn (no liveTurn) delegating to a specialist must not
    // manufacture live-ness — the sub-task stays non-live and elevated skills stay blocked.
    const { bus, published } = makeBus();
    const result = await new DelegateHandler().execute(makeCtx(bus, { liveTurn: undefined }));
    expect(result.success).toBe(true);

    const task = published.find(e => e.type === 'agent.task') as AgentTaskEvent;
    expect(task.payload.liveTurn).toBeUndefined();
  });
});

describe('DelegateHandler resume_token decode', () => {
  it('builds a task brief from a valid resume_token (original task + progress + CEO direction)', async () => {
    const { bus, published } = makeBus();
    const resume_token = encodeResumeToken({
      agent: 'research-analyst',
      originalTask: 'compile the acquisition comps',
      context: 'gathered 3 of 5 comps; blocked on the private ones',
    });
    const result = await new DelegateHandler().execute(
      makeCtx(bus, { input: { agent: 'research-analyst', task: 'use the public filings only', resume_token } }),
    );
    expect(result.success).toBe(true);
    const task = published.find(e => e.type === 'agent.task');
    expect(task).toBeDefined();
    expect((task as AgentTaskEvent).payload.content).toContain('compile the acquisition comps'); // original_task
    expect((task as AgentTaskEvent).payload.content).toContain('gathered 3 of 5 comps');          // progress/context
    expect((task as AgentTaskEvent).payload.content).toContain('use the public filings only');    // CEO direction (task)
  });

  it('rejects a malformed resume_token without publishing a task', async () => {
    const { bus, published } = makeBus();
    const result = await new DelegateHandler().execute(
      makeCtx(bus, { input: { agent: 'research-analyst', task: 'continue', resume_token: '!!!not base64 json!!!' } }),
    );
    if (result.success) throw new Error('expected delegate to reject a malformed resume_token');
    expect(result.error).toMatch(/could not be decoded|corrupted/i);
    expect(published.find(e => e.type === 'agent.task')).toBeUndefined();
  });

  it('rejects a resume_token minted for a different specialist (cross-agent guard)', async () => {
    const { bus, published } = makeBus();
    const resume_token = encodeResumeToken({ agent: 'accounts-specialist', originalTask: 'x', context: 'y' });
    const result = await new DelegateHandler().execute(
      makeCtx(bus, { input: { agent: 'research-analyst', task: 'continue', resume_token } }),
    );
    if (result.success) throw new Error('expected delegate to reject a cross-agent resume_token');
    expect(result.error).toMatch(/accounts-specialist/);
    expect(published.find(e => e.type === 'agent.task')).toBeUndefined();
  });

  it('rejects a resume_token with an empty agent field (cross-agent guard bypass via falsy agent)', async () => {
    const { bus, published } = makeBus();
    // Encode a token with agent: "" — decodeResumeToken accepts it (validates only typeof),
    // so the handler's strict-equality guard must reject it rather than letting it through via
    // the old `payload.agent && payload.agent !== agent` falsy-bypass.
    const resume_token = Buffer.from(
      JSON.stringify({ v: 1, agent: '', original_task: 'orig task', context: 'progress' }),
    ).toString('base64');
    const result = await new DelegateHandler().execute(
      makeCtx(bus, { input: { agent: 'research-analyst', task: 'continue', resume_token } }),
    );
    if (result.success) throw new Error('expected delegate to reject an empty-agent resume_token');
    expect(result.error).toMatch(/empty agent field|corrupted/i);
    expect(published.find(e => e.type === 'agent.task')).toBeUndefined();
  });

  it('rejects a resume_token whose required field is an empty string', async () => {
    const { bus, published } = makeBus();
    // Valid base64/JSON with the right keys, but original_task is empty — the shared decode accepts
    // it (it is a string), so the handler's own empty-field guard must still reject it.
    const resume_token = encodeResumeToken({ agent: 'research-analyst', originalTask: '', context: 'y' });
    const result = await new DelegateHandler().execute(
      makeCtx(bus, { input: { agent: 'research-analyst', task: 'continue', resume_token } }),
    );
    if (result.success) throw new Error('expected delegate to reject an empty-field resume_token');
    expect(result.error).toMatch(/missing required fields/i);
    expect(published.find(e => e.type === 'agent.task')).toBeUndefined();
  });

  it('warns but proceeds when the resume_token version does not match', async () => {
    const { bus, published } = makeBus();
    const logger = pino({ level: 'silent' });
    const warnSpy = vi.spyOn(logger, 'warn');
    // Hand-craft a token with a future version (encodeResumeToken always stamps the current one).
    const resume_token = Buffer.from(
      JSON.stringify({ v: 99, agent: 'research-analyst', original_task: 'orig task', context: 'progress' }),
    ).toString('base64');
    const result = await new DelegateHandler().execute(
      makeCtx(bus, { log: logger, input: { agent: 'research-analyst', task: 'continue', resume_token } }),
    );
    expect(result.success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tokenVersion: 99, expectedVersion: 1 }),
      expect.stringMatching(/version mismatch/i),
    );
    // Despite the mismatch it still proceeds and builds the brief.
    const task = published.find(e => e.type === 'agent.task');
    expect(task).toBeDefined();
    expect((task as AgentTaskEvent).payload.content).toContain('orig task');
  });
});
