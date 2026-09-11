// handler.test.ts — list-user-secrets skill (#1497).

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { ListUserSecretsHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';

function makeCtx(
  listUserSecretNames: ToolContext['listUserSecretNames'],
): ToolContext {
  return {
    input: {},
    secret: () => {
      throw new Error('list-user-secrets must not call ctx.secret()');
    },
    log: pino({ level: 'silent' }),
    listUserSecretNames,
  } as unknown as ToolContext;
}

describe('ListUserSecretsHandler', () => {
  it('returns user.* names only, sorted, never values', async () => {
    const listed = [
      'user.my_twitter_x_password',
      'user.aeroplan_password',
      'user.x_com_password',
    ];
    const ctx = makeCtx(vi.fn().mockResolvedValue(listed));
    const result = await new ListUserSecretsHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.keys).toEqual([
      'user.aeroplan_password',
      'user.my_twitter_x_password',
      'user.x_com_password',
    ]);
    expect(data.count).toBe(3);
    expect(JSON.stringify(data)).not.toMatch(/hunter2|secret-value|password-value/i);
    expect(data).not.toHaveProperty('values');
    expect(data).not.toHaveProperty('value');
  });

  it('never lists a seeded anthropic_api_key or channel.* secret', async () => {
    // The capability is already scoped, but the handler must also drop anything
    // that is not user.* — this is the AC assertion from #1497.
    const ctx = makeCtx(vi.fn().mockResolvedValue([
      'anthropic_api_key',
      'channel.email.nylas_api_key',
      'channel.signal.phone_number',
      'api_token',
      'web_app_bootstrap_secret',
      'user.flight_password',
    ]));
    const result = await new ListUserSecretsHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { keys: string[] } }).data;
    expect(data.keys).toEqual(['user.flight_password']);
    expect(data.keys).not.toContain('anthropic_api_key');
    expect(data.keys.some(k => k.startsWith('channel.'))).toBe(false);
    expect(data.keys).not.toContain('api_token');
    expect(data.keys).not.toContain('web_app_bootstrap_secret');
  });

  it('returns an empty list when no user.* secrets exist', async () => {
    const ctx = makeCtx(vi.fn().mockResolvedValue([]));
    const result = await new ListUserSecretsHandler().execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { keys: string[]; count: number } }).data;
    expect(data.keys).toEqual([]);
    expect(data.count).toBe(0);
  });

  it('errors when the userSecretIndex capability is missing', async () => {
    const ctx = makeCtx(undefined);
    const result = await new ListUserSecretsHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('never calls ctx.secret() (no value access path)', async () => {
    const secret = vi.fn(() => 'should-not-run');
    const ctx = {
      input: {},
      secret,
      log: pino({ level: 'silent' }),
      listUserSecretNames: vi.fn().mockResolvedValue(['user.x']),
    } as unknown as ToolContext;
    await new ListUserSecretsHandler().execute(ctx);
    expect(secret).not.toHaveBeenCalled();
  });
});
