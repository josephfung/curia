import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { createVerificationRuntime } from '../../../src/verification/index.js';
import type { ChannelIdentity } from '../../../src/contacts/types.js';
import type { DbPool } from '../../../src/db/connection.js';
import type { VerificationConfig, Verification } from '../../../src/verification/types.js';

const logger = pino({ level: 'silent' });

const config: VerificationConfig = {
  askChannelOrder: ['signal', 'sms', 'slack', 'email'],
  defaultExpiryMinutes: 10,
  recentWindowMinutes: 120,
  codeTtlMinutesAfterClose: 120,
  emailWaitSeconds: 180,
  identityProviderDomains: ['b2clogin.com'],
};

function identity(channel: string, overrides: Partial<ChannelIdentity> = {}): ChannelIdentity {
  return {
    id: `id-${channel}`,
    contactId: 'principal',
    channel,
    channelIdentifier: `${channel}-handle`,
    label: null,
    verified: true,
    verifiedAt: new Date(),
    status: 'active',
    source: 'ceo_stated',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const pool = { query: vi.fn() } as unknown as DbPool;

function runtimeFor(identities: ChannelIdentity[], enabled: string[]) {
  return createVerificationRuntime(pool, logger, config, identities, new Set(enabled));
}

describe('VerificationRuntime.askChannel', () => {
  it('picks signal when enabled and verified', () => {
    const rt = runtimeFor([identity('signal'), identity('email')], ['signal', 'email']);
    expect(rt.askChannel()).toBe('signal');
  });

  it('skips signal with no verified identity → sms', () => {
    const rt = runtimeFor(
      [identity('signal', { verified: false }), identity('sms'), identity('email')],
      ['signal', 'sms', 'email'],
    );
    expect(rt.askChannel()).toBe('sms');
  });

  it('matches an sms ask against a phone identity', () => {
    const rt = runtimeFor([identity('phone')], ['sms']);
    expect(rt.askChannel()).toBe('sms');
  });

  it('skips a channel that is not enabled even with a verified identity', () => {
    const rt = runtimeFor([identity('signal'), identity('slack')], ['slack']);
    expect(rt.askChannel()).toBe('slack');
  });

  it('skips an inactive identity', () => {
    const rt = runtimeFor([identity('signal', { status: 'defunct' }), identity('email')], ['signal', 'email']);
    expect(rt.askChannel()).toBe('email');
  });

  it('returns null when nothing qualifies', () => {
    expect(runtimeFor([identity('signal', { verified: false })], ['signal', 'sms']).askChannel()).toBeNull();
    expect(runtimeFor([identity('signal')], []).askChannel()).toBeNull();
    expect(runtimeFor([], ['signal']).askChannel()).toBeNull();
  });

  it('ignores the request channel entirely', () => {
    const rt = runtimeFor([identity('signal'), identity('email')], ['signal', 'email']);
    // No parameter exists: the errand's channel can never steer the ask.
    expect(rt.askChannel.length).toBe(0);
  });

  it('reads the identity array live, so an in-place refresh changes the answer', () => {
    const identities = [identity('email')];
    const rt = runtimeFor(identities, ['signal', 'email']);
    expect(rt.askChannel()).toBe('email');
    identities.push(identity('signal'));
    expect(rt.askChannel()).toBe('signal');
  });
});

describe('VerificationRuntime tracker aging (cross-task ruling)', () => {
  function row(id: string, status: Verification['status']): Verification {
    return {
      id, purpose: 'sign_in', kind: 'code', delivery: 'sms', site: 'example.com',
      pageDomain: 'accounts.example.com', browserSessionId: 's', taskId: null, conversationId: null,
      status, requestedAt: new Date(), expiresAt: new Date(), resolvedAt: null, metadata: {},
    };
  }

  it('listActive starts the TTL clock for every non-pending row and not for pending ones', async () => {
    const rt = runtimeFor([], []);
    for (const id of ['a', 'b', 'c']) rt.tracker.register(id, 'accounts.example.com', `${id.charCodeAt(0)}12345`);
    const closed = vi.spyOn(rt.tracker, 'closed');
    vi.spyOn(rt.service, 'listActive').mockResolvedValue([row('a', 'pending'), row('b', 'expired'), row('c', 'satisfied')]);
    const rows = await rt.listActive();
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(closed.mock.calls.map(c => c[0])).toEqual(['b', 'c']);
  });

  it('a verification expired outside the recent window still starts the TTL clock', async () => {
    const rt = runtimeFor([], []);
    rt.tracker.register('old', 'accounts.example.com', '482913');
    rt.tracker.register('live', 'accounts.example.com', '777111');
    const closed = vi.spyOn(rt.tracker, 'closed');
    // The service expired 'old' lazily but, being past the window, did not return it.
    vi.spyOn(rt.service, 'listActive').mockResolvedValue([row('live', 'pending')]);
    await rt.listActive();
    expect(closed.mock.calls.map(c => c[0])).toEqual(['old']);
  });

  it('open() on the same site ages out the stale verification\'s values', async () => {
    const rt = runtimeFor([], []);
    rt.tracker.register('stale', 'accounts.example.com', '482913');
    const closed = vi.spyOn(rt.tracker, 'closed');
    const fresh = row('fresh', 'pending');
    // service.open expired 'stale' silently; only the new row is pending afterwards.
    vi.spyOn(rt.service, 'open').mockResolvedValue({ verification: fresh, reused: false });
    vi.spyOn(rt.service, 'listActive').mockResolvedValue([fresh]);
    const result = await rt.open({
      purpose: 'sign_in', kind: 'code', delivery: 'sms', site: 'example.com',
      pageDomain: 'accounts.example.com', browserSessionId: 's',
    });
    expect(result.verification.id).toBe('fresh');
    expect(closed.mock.calls.map(c => c[0])).toEqual(['stale']);
  });

  it('open() reusing a row whose page moved retargets the tracker, so the guard follows it', async () => {
    const rt = runtimeFor([], []);
    rt.tracker.register('v', 'accounts.example.com', '482913');
    const moved = { ...row('v', 'pending'), pageDomain: 'b2clogin.com', browserSessionId: 's-new' };
    vi.spyOn(rt.service, 'open').mockResolvedValue({ verification: moved, reused: true });
    vi.spyOn(rt.service, 'listActive').mockResolvedValue([moved]);
    await rt.open({
      purpose: 'sign_in', kind: 'code', delivery: 'sms', site: 'example.com',
      pageDomain: 'https://acme.b2clogin.com/mfa', browserSessionId: 's-new',
    });
    expect(rt.tracker.allowedDomainsFor('482913')).toEqual(new Set(['b2clogin.com']));
  });

  it('close() marks the tracker closed', async () => {
    const rt = runtimeFor([], []);
    const closed = vi.spyOn(rt.tracker, 'closed');
    vi.spyOn(rt.service, 'close').mockResolvedValue(row('a', 'satisfied'));
    await rt.close('a', 'satisfied');
    expect(closed).toHaveBeenCalledWith('a');
  });
});
