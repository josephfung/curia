// handler.test.ts — secret-capture-request skill.

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { SecretCaptureRequestHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { SecretCaptureMinter, MintResult } from '../../src/secrets/secret-capture-service.js';

function fakeMinter(over: Partial<MintResult> = {}): SecretCaptureMinter & { userCalls: unknown[]; systemCalls: unknown[] } {
  const userCalls: unknown[] = [];
  const systemCalls: unknown[] = [];
  return {
    userCalls,
    systemCalls,
    async mintUserSecret(args) {
      userCalls.push(args);
      return { rawToken: 'abc123', secretName: 'user.flight', expiresAt: new Date(Date.now() + 30 * 60_000), ...over };
    },
    async mintSystemSecret(args) {
      systemCalls.push(args);
      return { rawToken: 'abc123', secretName: 'anthropic_api_key', expiresAt: new Date(), ...over };
    },
  };
}

function makeCtx(input: Record<string, unknown>, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    input,
    secret: () => 'unused',
    log: pino({ level: 'silent' }),
    secretCapture: fakeMinter(),
    appOrigin: 'https://curia.example.com',
    ...overrides,
  } as unknown as ToolContext;
}

describe('SecretCaptureRequestHandler', () => {
  it('mints a user secret and builds the URL from appOrigin', async () => {
    const minter = fakeMinter();
    const ctx = makeCtx({ secret_name: 'my flight password' }, { secretCapture: minter, timezone: 'America/Toronto' });
    const result = await new SecretCaptureRequestHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.capture_url).toBe('https://curia.example.com/secret-capture/abc123');
    expect(data.secret_name).toBe('user.flight');
    // origin is always present (#972); with no routing on ctx its fields are undefined and
    // resumeIntent falls back to the label. toEqual ignores undefined-valued properties.
    expect(minter.userCalls).toEqual([{ rawName: 'my flight password', label: 'my flight password', valueFormat: 'string', origin: { resumeIntent: 'my flight password' } }]);
    // Timestamp-metadata contract: the field is `displayTimezone` (camelCase), not snake_case.
    expect(typeof data.displayTimezone).toBe('string');
    expect(data).not.toHaveProperty('display_timezone');
  });

  it('falls back to localhost:{httpPort} when appOrigin is unset', async () => {
    const ctx = makeCtx({ secret_name: 'x' }, { appOrigin: undefined, httpPort: 4521 });
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.capture_url).toBe('http://localhost:4521/secret-capture/abc123');
  });

  it('trims a trailing slash on appOrigin so the URL has no double slash', async () => {
    const ctx = makeCtx({ secret_name: 'x' }, { appOrigin: 'https://curia.example.com/' });
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.capture_url).toBe('https://curia.example.com/secret-capture/abc123');
  });

  it('never returns the submitted value (mint surface has no read path)', async () => {
    const ctx = makeCtx({ secret_name: 'x' });
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    // The output carries only the link + metadata, never a value field.
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(Object.keys(data)).not.toContain('value');
  });

  it('rejects a missing secret_name', async () => {
    const ctx = makeCtx({});
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid value_format', async () => {
    const ctx = makeCtx({ secret_name: 'x', value_format: 'xml' });
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('errors when the secretCapture capability is missing', async () => {
    const ctx = makeCtx({ secret_name: 'x' }, { secretCapture: undefined });
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('passes value_format through to the minter', async () => {
    const minter = fakeMinter();
    const ctx = makeCtx({ secret_name: 'creds', value_format: 'json' }, { secretCapture: minter });
    await new SecretCaptureRequestHandler().execute(ctx);
    expect(minter.userCalls).toEqual([{ rawName: 'creds', label: 'creds', valueFormat: 'json', origin: { resumeIntent: 'creds' } }]);
  });

  it('captures origin routing context from ctx for resume (#972)', async () => {
    const minter = fakeMinter();
    const originator = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' };
    const ctx = makeCtx(
      { secret_name: 'Aeroplan password', resume_intent: 'check the Aeroplan balance' },
      {
        secretCapture: minter,
        conversationId: 'conv-1',
        channelId: 'email',
        agentId: 'coordinator',
        taskEventId: 'task-evt-9',
        taskMetadata: { originator },
      },
    );
    await new SecretCaptureRequestHandler().execute(ctx);
    expect(minter.userCalls).toEqual([{
      rawName: 'Aeroplan password',
      label: 'Aeroplan password',
      valueFormat: 'string',
      origin: {
        conversationId: 'conv-1',
        channelId: 'email',
        agentId: 'coordinator',
        taskEventId: 'task-evt-9',
        originator,
        resumeIntent: 'check the Aeroplan balance',
      },
    }]);
  });

  it('retargets origin at the coordinator and mints a resume_token when delegated (#995)', async () => {
    const minter = fakeMinter();
    const originator = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' };
    const ctx = makeCtx(
      { secret_name: 'Aeroplan password', resume_intent: 'check the Aeroplan balance' },
      {
        secretCapture: minter,
        // Specialist's own (internal) routing — must NOT be used as the resume target:
        conversationId: 'delegate-xyz',
        channelId: 'internal',
        agentId: 'accounts-specialist',
        taskMetadata: {
          originator,
          delegationOrigin: { conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator', originalTask: 'log into Aeroplan and check balance' },
        },
      },
    );
    await new SecretCaptureRequestHandler().execute(ctx);
    expect(minter.userCalls[0]).toBeDefined();
    const call = minter.userCalls[0]! as { origin: Record<string, unknown> };
    // Re-entry targets the coordinator on its deliverable channel, not the internal specialist ctx.
    expect(call.origin.conversationId).toBe('user-conv');
    expect(call.origin.channelId).toBe('email');
    expect(call.origin.agentId).toBe('coordinator');
    expect(call.origin.originator).toEqual(originator);
    // The resume_token names the specialist to re-delegate to.
    const { decodeResumeToken } = await import('../../src/agents/resume-token.js');
    const decoded = decodeResumeToken(call.origin.resumeToken as string)!;
    expect(decoded.agent).toBe('accounts-specialist');
    expect(decoded.original_task).toBe('log into Aeroplan and check balance');
    expect(call.origin.resumeIntent).toBe('check the Aeroplan balance');
  });

  it('does NOT set resumeToken or retarget when not delegated (coordinator-minted)', async () => {
    const minter = fakeMinter();
    const ctx = makeCtx(
      { secret_name: 'Aeroplan password' },
      { secretCapture: minter, conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator' },
    );
    await new SecretCaptureRequestHandler().execute(ctx);
    expect(minter.userCalls[0]).toBeDefined();
    const call = minter.userCalls[0]! as { origin: Record<string, unknown> };
    expect(call.origin.agentId).toBe('coordinator');
    expect(call.origin).not.toHaveProperty('resumeToken');
  });
});
