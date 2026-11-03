import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '../../src/skills/types.js';
import { curiaOwnAddresses } from './curia-own-addresses.js';

function ctxWith(selfEmails: string[], live?: () => Promise<string[]>) {
  const warn = vi.fn();
  const ctx = { selfEmails, curiaEmailAddresses: live, log: { warn } } as unknown as ToolContext;
  return { ctx, warn };
}

describe('curiaOwnAddresses (#2409)', () => {
  it('includes a mailbox added since boot, lowercased', async () => {
    const { ctx } = ctxWith(['Curia@Example.com'], async () => ['curia@example.com', 'Sched@Example.com']);
    expect(await curiaOwnAddresses(ctx, 't')).toEqual(new Set(['curia@example.com', 'sched@example.com']));
  });

  it('falls back to the boot list when the live read fails', async () => {
    const { ctx, warn } = ctxWith(['curia@example.com'], async () => { throw new Error('db down'); });
    expect(await curiaOwnAddresses(ctx, 't')).toEqual(new Set(['curia@example.com']));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('lookup failed'));
  });

  // A stalled query never rejects; the boot list must still come back before the tool deadline.
  it('falls back to the boot list when the live read stalls past the timeout', async () => {
    const { ctx, warn } = ctxWith(['curia@example.com'], () => new Promise<string[]>(() => {}));
    expect(await curiaOwnAddresses(ctx, 't', 20)).toEqual(new Set(['curia@example.com']));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('lookup failed'));
  });

  it('uses the boot list when the capability is absent, and warns when there is nothing', async () => {
    expect(await curiaOwnAddresses(ctxWith(['a@x.com']).ctx, 't')).toEqual(new Set(['a@x.com']));
    const { ctx, warn } = ctxWith([]);
    expect((await curiaOwnAddresses(ctx, 't')).size).toBe(0);
    expect(warn).toHaveBeenCalledWith({}, expect.stringContaining('no email accounts'));
  });
});
