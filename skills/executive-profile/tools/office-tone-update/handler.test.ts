// handler.test.ts — office-tone-update skill
import { describe, it, expect, vi } from 'vitest';
import { OfficeToneUpdateHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { OfficeIdentity } from '../../../../src/identity/types.js';

const BASE_IDENTITY: OfficeIdentity = {
  assistant: { name: 'Curia', title: 'Chief of Staff', emailSignature: '' },
  tone: { style: 'Professional.', verbosity: 50 },
  behavioralPreferences: ['Be concise'],
  constraints: ['No legal advice'],
};

function setup(input: Record<string, unknown>) {
  const service = {
    get: vi.fn((): OfficeIdentity => BASE_IDENTITY),
    update: vi.fn(async () => undefined),
  };
  const ctx = {
    input,
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    caller: { role: 'principal', contactId: 'contact-123' },
    officeIdentityService: service,
  } as unknown as ToolContext;
  return { service, ctx };
}

describe('OfficeToneUpdateHandler', () => {
  it('rejects a style over the length limit', async () => {
    const { ctx, service } = setup({ style: 'x'.repeat(801) });
    const r = await new OfficeToneUpdateHandler().execute(ctx);
    expect(r.success).toBe(false);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('rejects verbosity 101', async () => {
    const { ctx, service } = setup({ verbosity: 101 });
    const r = await new OfficeToneUpdateHandler().execute(ctx);
    expect(r.success).toBe(false);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('rejects a call with neither style nor verbosity', async () => {
    const { ctx, service } = setup({});
    const r = await new OfficeToneUpdateHandler().execute(ctx);
    expect(r.success).toBe(false);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('updates only the tone on a valid call', async () => {
    const { ctx, service } = setup({ style: 'Warm and direct.' });
    const r = await new OfficeToneUpdateHandler().execute(ctx);
    expect(r).toEqual({ success: true, data: { style: 'Warm and direct.', verbosity: 50 } });
    expect(service.update).toHaveBeenCalledTimes(1);
    const [next, changedBy] = service.update.mock.calls[0] as unknown as [OfficeIdentity, string];
    expect(next).toEqual({ ...BASE_IDENTITY, tone: { style: 'Warm and direct.', verbosity: 50 } });
    expect(changedBy).toBe('tool');
  });
});
