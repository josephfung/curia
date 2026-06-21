// specialist-resume-flow.test.ts — end-to-end (no DB/LLM) flow for #995: a delegated specialist
// mints a capture link → redeem → secret.captured → coordinator is re-entered to re-delegate.
//
// Lives in skills/secret-capture-request/ rather than src/secrets/ because this test imports
// from both skills/ and src/, and the main tsconfig has rootDir: "src" (TS6059 would fire from
// src/). The tsconfig.skills.json covers this tree with rootDir: "." allowing cross-tree imports.
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { SecretCaptureRequestHandler } from './handler.js';
import { SecretCaptureResumeSubscriber, type ResumeRoutingRegistrar } from '../../src/secrets/secret-capture-resume-subscriber.js';
import { createSecretCaptured } from '../../src/bus/events.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { SecretCaptureMinter, CaptureOrigin } from '../../src/secrets/secret-capture-service.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { BusEvent, Layer, EventType, AgentTaskEvent } from '../../src/bus/events.js';

describe('specialist secret-capture resume flow (#995)', () => {
  it('delegated mint → secret.captured → coordinator re-delegate task (value never leaks)', async () => {
    // 1. Capture skill, run as a delegated specialist, records the origin it would persist.
    let captured: CaptureOrigin | undefined;
    const minter: SecretCaptureMinter = {
      async mintUserSecret(args) { captured = args.origin; return { rawToken: 'tok', secretName: 'user.aeroplan_password', expiresAt: new Date(Date.now() + 1e6) }; },
      async mintSystemSecret(args) { captured = args.origin; return { rawToken: 'tok', secretName: 'x', expiresAt: new Date() }; },
    };
    const originator = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' };
    const skillCtx = {
      input: { secret_name: 'Aeroplan password', resume_intent: 'check the Aeroplan balance' },
      log: pino({ level: 'silent' }),
      secretCapture: minter,
      appOrigin: 'https://curia.example.com',
      conversationId: 'delegate-xyz', channelId: 'internal', agentId: 'accounts-specialist',
      taskMetadata: { originator, delegationOrigin: { conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator', originalTask: 'log into Aeroplan and check balance' } },
    } as unknown as SkillContext;
    const res = await new SecretCaptureRequestHandler().execute(skillCtx);
    expect(res.success).toBe(true);
    expect(captured!.agentId).toBe('coordinator');
    expect(captured!.resumeToken).toBeTruthy();

    // 2. Redeem returns CapturedContext mirroring the persisted origin (the service round-trips it,
    //    covered in Task 2); the endpoint publishes secret.captured from it.
    const event = createSecretCaptured({
      secretName: 'user.aeroplan_password',
      label: 'Aeroplan password',
      conversationId: captured!.conversationId,
      channelId: captured!.channelId,
      agentId: captured!.agentId,
      resumeIntent: captured!.resumeIntent,
      originator: captured!.originator,
      resumeToken: captured!.resumeToken,
    });

    // 3. Real subscriber re-enters the coordinator.
    const published: Array<{ layer: Layer; event: BusEvent }> = [];
    const handlers = new Map<EventType, Array<(e: BusEvent) => unknown>>();
    const bus = {
      subscribe(type: EventType, _l: Layer, h: (e: BusEvent) => unknown) { const a = handlers.get(type) ?? []; a.push(h); handlers.set(type, a); },
      async publish(layer: Layer, event: BusEvent) { published.push({ layer, event }); },
    } as unknown as EventBus;
    const routingCalls: Array<unknown> = [];
    const register: ResumeRoutingRegistrar = (_id, routing) => { routingCalls.push(routing); };
    new SecretCaptureResumeSubscriber(bus, pino({ level: 'silent' }), register).start();
    for (const h of handlers.get('secret.captured') ?? []) await h(event);

    expect(published).toHaveLength(1);
    const task = published[0]!.event as AgentTaskEvent;
    expect(task.payload.agentId).toBe('coordinator');         // re-enters the coordinator…
    expect(task.payload.conversationId).toBe('user-conv');    // …in the user's conversation…
    expect(task.payload.channelId).toBe('email');             // …on a deliverable channel.
    expect(task.payload.content).toContain('accounts-specialist');  // re-delegate target
    expect(task.payload.content).toContain(captured!.resumeToken);  // token forwarded verbatim
    expect(task.payload.metadata).toEqual({ originator });    // originator preserved end-to-end
    expect(routingCalls).toHaveLength(1);
    // Privacy: no secret value anywhere in the chain.
    expect(JSON.stringify({ captured, event, task })).not.toContain('hunter2');
  });
});
