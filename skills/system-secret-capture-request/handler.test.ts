// handler.test.ts — system-secret-capture-request skill.
//
// allowed_callers enforcement (setup-wizard only) is the execution layer's job and is covered
// generically in src/skills/execution.test.ts; the manifest declaration is what wires it. These
// tests cover the handler's own behavior: it mints via the SYSTEM name policy and surfaces a
// rejected (non-declared/non-channel) name as an error.

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { SystemSecretCaptureRequestHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { SecretCaptureMinter, MintResult } from '../../src/secrets/secret-capture-service.js';
import { decodeResumeToken } from '../../src/agents/resume-token.js';

function fakeMinter(opts: { reject?: boolean; result?: Partial<MintResult> } = {}): SecretCaptureMinter & { systemCalls: unknown[] } {
  const systemCalls: unknown[] = [];
  return {
    systemCalls,
    async mintUserSecret() {
      throw new Error('user policy must not be used by the system skill');
    },
    async mintSystemSecret(args) {
      systemCalls.push(args);
      if (opts.reject) throw new Error("'made_up' is not a declared skill secret nor a known channel credential key");
      return { rawToken: 'tok', secretName: 'anthropic_api_key', expiresAt: new Date(Date.now() + 30 * 60_000), ...opts.result };
    },
  };
}

function makeCtx(input: Record<string, unknown>, minter: SecretCaptureMinter | undefined = fakeMinter()): SkillContext {
  return {
    input,
    secret: () => 'unused',
    log: pino({ level: 'silent' }),
    secretCapture: minter,
    appOrigin: 'https://curia.example.com',
  } as unknown as SkillContext;
}

describe('SystemSecretCaptureRequestHandler', () => {
  it('mints via the system name policy and returns the link', async () => {
    const minter = fakeMinter();
    const ctx = makeCtx({ secret_name: 'anthropic_api_key' }, minter);
    const result = await new SystemSecretCaptureRequestHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.capture_url).toBe('https://curia.example.com/secret-capture/tok');
    expect(data.secret_name).toBe('anthropic_api_key');
    // origin is now always threaded; only assert the name-policy fields here.
    expect(minter.systemCalls).toHaveLength(1);
    expect(minter.systemCalls[0]).toEqual(expect.objectContaining({ rawName: 'anthropic_api_key', label: 'anthropic_api_key', valueFormat: 'string' }));
  });

  it('uses mintSystemSecret, never mintUserSecret', async () => {
    // The fake's mintUserSecret throws — a passing test proves the system path was taken.
    const ctx = makeCtx({ secret_name: 'anthropic_api_key' });
    const result = await new SystemSecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(true);
  });

  it('surfaces a rejected (unknown) name as a skill error', async () => {
    const ctx = makeCtx({ secret_name: 'made_up' }, fakeMinter({ reject: true }));
    const result = await new SystemSecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/not a declared/);
  });

  it('rejects a missing secret_name', async () => {
    const ctx = makeCtx({});
    const result = await new SystemSecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid value_format', async () => {
    const ctx = makeCtx({ secret_name: 'anthropic_api_key', value_format: 'xml' });
    const result = await new SystemSecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('falls back to localhost:{httpPort} when appOrigin is unset', async () => {
    const ctx = {
      input: { secret_name: 'anthropic_api_key' },
      secret: () => 'unused',
      log: pino({ level: 'silent' }),
      secretCapture: fakeMinter({ result: { rawToken: 'tok' } }),
      appOrigin: undefined,
      httpPort: 4521,
    } as unknown as SkillContext;
    const result = await new SystemSecretCaptureRequestHandler().execute(ctx);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.capture_url).toBe('http://localhost:4521/secret-capture/tok');
  });

  it('errors when the secretCapture capability is missing', async () => {
    const ctx = {
      input: { secret_name: 'anthropic_api_key' },
      secret: () => 'unused',
      log: pino({ level: 'silent' }),
      secretCapture: undefined,
    } as unknown as SkillContext;
    const result = await new SystemSecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(false);
  });
});

// --- #995 origin threading tests (appended per task-6-brief) ---

function fakeMinterWithUserCalls(over: Partial<MintResult> = {}): SecretCaptureMinter & { userCalls: unknown[]; systemCalls: unknown[] } {
  const userCalls: unknown[] = [];
  const systemCalls: unknown[] = [];
  return {
    userCalls, systemCalls,
    async mintUserSecret(args) { userCalls.push(args); return { rawToken: 'abc123', secretName: 'user.x', expiresAt: new Date(), ...over }; },
    async mintSystemSecret(args) { systemCalls.push(args); return { rawToken: 'abc123', secretName: 'channel.email.nylas_api_key', expiresAt: new Date(), ...over }; },
  };
}

function makeCtxWithOverrides(input: Record<string, unknown>, overrides: Partial<SkillContext> = {}): SkillContext {
  return { input, log: pino({ level: 'silent' }), secretCapture: fakeMinterWithUserCalls(), appOrigin: 'https://curia.example.com', ...overrides } as unknown as SkillContext;
}

describe('SystemSecretCaptureRequestHandler (#995)', () => {
  it('threads coordinator routing + resume_token when delegated (setup-wizard)', async () => {
    const minter = fakeMinterWithUserCalls();
    const originator = { contactId: 'ceo', systemRole: 'principal', channel: 'web', initiatedAt: 't' };
    const ctx = makeCtxWithOverrides(
      { secret_name: 'channel.email.nylas_api_key', label: 'Nylas API key' },
      {
        secretCapture: minter,
        conversationId: 'delegate-xyz', channelId: 'internal', agentId: 'setup-wizard',
        taskMetadata: { originator, delegationOrigin: { conversationId: 'user-conv', channelId: 'web', agentId: 'coordinator', originalTask: 'set up email' } },
      },
    );
    const result = await new SystemSecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(true);
    const call = minter.systemCalls[0]! as { origin: Record<string, unknown> };
    expect(call.origin.conversationId).toBe('user-conv');
    expect(call.origin.channelId).toBe('web');
    expect(call.origin.agentId).toBe('coordinator');
    expect(call.origin.originator).toEqual(originator);
    expect(decodeResumeToken(call.origin.resumeToken as string)!.agent).toBe('setup-wizard');
  });
});
