// Shared code-registration rules (#2017, design §1/§5): a value registers only against a
// pending, expired or abandoned verification, never a satisfied one, and a non-pending row
// starts its TTL clock as soon as it is registered against.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { CodeTracker } from '../../../src/verification/code-tracker.js';
import { registerCodes, trackInboxCodes } from '../../../src/verification/track-codes.js';
import type { VerificationRuntime } from '../../../src/verification/index.js';
import type { Verification, VerificationDelivery, VerificationStatus } from '../../../src/verification/types.js';

function row(id: string, status: VerificationStatus, delivery: VerificationDelivery = 'email'): Verification {
  return {
    id, purpose: 'sign_in', kind: 'code', delivery, site: 'aircanada.com',
    pageDomain: 'aircanada.com', browserSessionId: 's', taskId: null, conversationId: null,
    status, requestedAt: new Date(), expiresAt: new Date(Date.now() + 600_000), resolvedAt: null, metadata: {},
  };
}

function runtimeWith(rows: Verification[] | Error) {
  const tracker = new CodeTracker({ ttlMinutesAfterClose: 120 });
  const register = vi.spyOn(tracker, 'register');
  const closed = vi.spyOn(tracker, 'closed');
  const listActive = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  const runtime = { tracker, listActive } as unknown as VerificationRuntime;
  return { runtime, tracker, register, closed, listActive };
}

describe('registerCodes', () => {
  it('registers against pending, expired and abandoned rows, never satisfied', () => {
    const { runtime, register } = runtimeWith([]);
    const rows = [row('p', 'pending'), row('e', 'expired'), row('a', 'abandoned'), row('s', 'satisfied')];
    const registered = registerCodes(runtime, rows, ['739204']);
    expect(registered.map((v) => v.id)).toEqual(['p', 'e', 'a']);
    expect(register.mock.calls.map((c) => c[0])).toEqual(['p', 'e', 'a']);
  });

  it('starts the TTL clock for every non-pending row it registered against', () => {
    const { runtime, closed } = runtimeWith([]);
    registerCodes(runtime, [row('p', 'pending'), row('e', 'expired'), row('a', 'abandoned'), row('s', 'satisfied')], ['739204']);
    expect(closed.mock.calls.map((c) => c[0])).toEqual(['e', 'a']);
  });

  it('registers nothing when there are no values', () => {
    const { runtime, register, closed } = runtimeWith([]);
    expect(registerCodes(runtime, [row('p', 'pending')], [])).toEqual([]);
    expect(register).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  });
});

describe('trackInboxCodes', () => {
  const log = () => {
    const l = pino({ level: 'silent' });
    return { l, info: vi.spyOn(l, 'info'), warn: vi.spyOn(l, 'warn') };
  };

  it('tracks a code against pending-or-recent email verifications only', async () => {
    const { runtime, register, tracker } = runtimeWith([
      row('mail', 'pending'), row('sms', 'pending', 'sms'), row('done', 'satisfied'),
    ]);
    const { l, info } = log();
    await trackInboxCodes(runtime, 'Your Air Canada code is 739204', l, { targetAgent: 'ceo-inbox' });
    expect(register.mock.calls.map((c) => c[0])).toEqual(['mail']);
    expect(tracker.scrubText('739204')).toBe('[sign-in code]');
    expect(JSON.stringify(info.mock.calls)).not.toContain('739204');
  });

  it('does not look anything up when the text holds no code-shaped value', async () => {
    const { runtime, listActive } = runtimeWith([row('mail', 'pending')]);
    await trackInboxCodes(runtime, 'nothing yet', pino({ level: 'silent' }));
    expect(listActive).not.toHaveBeenCalled();
  });

  it('never throws and logs no content when listing fails', async () => {
    const { runtime, register } = runtimeWith(new Error('db down 739204'));
    const { l, warn } = log();
    await expect(trackInboxCodes(runtime, 'code 739204', l)).resolves.toBeUndefined();
    expect(register).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('739204');
  });
});
