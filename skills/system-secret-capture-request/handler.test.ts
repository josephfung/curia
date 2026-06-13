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
    expect(minter.systemCalls).toEqual([{ rawName: 'anthropic_api_key', label: 'anthropic_api_key', valueFormat: 'string' }]);
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
