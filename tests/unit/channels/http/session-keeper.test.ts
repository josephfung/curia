import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import {
  SESSION_IDLE_TTL_MS,
  SESSION_RENEW_INTERVAL_MS,
  SessionKeeper,
  deviceNameFromUserAgent,
  normalizeDeviceName,
  sessionNeedsRenewal,
} from '../../../../src/channels/http/console-sessions.js';
import { hashToken, type SessionEntry, type SessionStore } from '../../../../src/channels/http/session-auth.js';
import { createSilentLogger } from '../../../../src/logger.js';

function replyStub(): FastifyReply & { setCookie: ReturnType<typeof vi.fn> } {
  const setCookie = vi.fn();
  return { setCookie } as unknown as FastifyReply & { setCookie: ReturnType<typeof vi.fn> };
}

describe('device labels', () => {
  it('names an iPhone Safari the way the pairing spike saw it', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';
    expect(deviceNameFromUserAgent(ua)).toBe('iPhone · Safari');
  });

  it('prefers Chrome over the Safari token in a desktop Chrome agent', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    expect(deviceNameFromUserAgent(ua)).toBe('Mac · Chrome');
  });

  it('rejects a blank, over-long, or control-character name', () => {
    expect(normalizeDeviceName('  Kitchen iPad  ')).toBe('Kitchen iPad');
    expect(normalizeDeviceName('')).toBeNull();
    expect(normalizeDeviceName('   ')).toBeNull();
    expect(normalizeDeviceName('a'.repeat(81))).toBeNull();
    expect(normalizeDeviceName('line\nbreak')).toBeNull();
    expect(normalizeDeviceName(`hide${'\u202E'}me`)).toBeNull();
    expect(normalizeDeviceName(`zero${'\u200B'}width`)).toBeNull();
    expect(normalizeDeviceName(12)).toBeNull();
  });

  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit CriOS/120.0.0.0 Mobile/15E148 Safari/604.1', 'iPhone · Chrome'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit FxiOS/120.0 Mobile/15E148 Safari/605.1.15', 'iPhone · Firefox'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit EdgiOS/120.0 Version/17.0 Mobile/15E148 Safari/604.1', 'iPhone · Edge'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit Chrome/120.0.0.0 Mobile Safari/537.36 EdgA/120.0.0.0', 'Android · Edge'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile/15E148 Safari/604.1', 'iPad · Safari'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Version/17.0 Mobile/15E148 Safari/604.1', 'iPad · Safari'],
  ])('labels %s', (ua, label) => {
    expect(deviceNameFromUserAgent(ua)).toBe(label);
  });
});

describe('SessionKeeper', () => {
  it('writes the idle window at most once per hour', () => {
    let now = 1_700_000_000_000;
    const hash = hashToken('raw-token');
    const original: SessionEntry = {
      id: 'session-1',
      expiresAt: now + 60_000,
      renewedAt: now - SESSION_RENEW_INTERVAL_MS,
    };
    const sessions: SessionStore = new Map([[hash, original]]);
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const keeper = new SessionKeeper({
      pool: { query },
      sessions,
      secureCookies: true,
      logger: createSilentLogger(),
      now: () => now,
    });
    const reply = replyStub();

    for (let i = 0; i < 5; i += 1) keeper.touch(hash, 'raw-token', reply);
    now += 30 * 60 * 1000;
    keeper.touch(hash, 'raw-token', reply);

    expect(query).toHaveBeenCalledTimes(1);
    expect(reply.setCookie).toHaveBeenCalledTimes(1);
    const updated = sessions.get(hash);
    expect(typeof updated).toBe('object');
    if (typeof updated === 'object') {
      expect(updated.expiresAt).toBe(1_700_000_000_000 + SESSION_IDLE_TTL_MS);
      expect(updated.renewedAt).toBe(1_700_000_000_000);
    }
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('COALESCE(name, $4)');
    expect(sql).toContain('COALESCE(user_agent, $5)');
    expect(params[0]).toBe(hash);
    expect(params[1]).toEqual(new Date(1_700_000_000_000 + SESSION_IDLE_TTL_MS));
  });

  it('renews again once the hour has passed', () => {
    let now = 5_000_000;
    const hash = hashToken('raw-token');
    const sessions: SessionStore = new Map([[hash, {
      id: 'session-2',
      expiresAt: now + SESSION_IDLE_TTL_MS,
      renewedAt: now,
    }]]);
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const keeper = new SessionKeeper({
      pool: { query },
      sessions,
      secureCookies: false,
      logger: createSilentLogger(),
      now: () => now,
    });
    keeper.touch(hash, 'raw-token', replyStub());
    expect(query).not.toHaveBeenCalled();
    now += SESSION_RENEW_INTERVAL_MS;
    keeper.touch(hash, 'raw-token', replyStub());
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('evicts the map entry when the renewal matches no row', async () => {
    const now = 4_000_000;
    const hash = hashToken('raw-token');
    const sessions: SessionStore = new Map([[hash, {
      id: 'session-gone',
      expiresAt: now + 1_000,
      renewedAt: now - SESSION_RENEW_INTERVAL_MS,
    }]]);
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const keeper = new SessionKeeper({
      pool: { query },
      sessions,
      secureCookies: false,
      logger: createSilentLogger(),
      now: () => now,
    });
    keeper.touch(hash, 'raw-token', replyStub());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sessions.has(hash)).toBe(false);
  });

  it('rolls the in-memory claim back when the write fails so the next request retries', async () => {
    const now = 9_000_000;
    const hash = hashToken('raw-token');
    const original: SessionEntry = {
      id: 'session-3',
      expiresAt: now + 1_000,
      renewedAt: now - SESSION_RENEW_INTERVAL_MS,
    };
    const sessions: SessionStore = new Map([[hash, original]]);
    const query = vi.fn().mockRejectedValue(new Error('db down'));
    const keeper = new SessionKeeper({
      pool: { query },
      sessions,
      secureCookies: false,
      logger: createSilentLogger(),
      now: () => now,
    });
    keeper.touch(hash, 'raw-token', replyStub());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sessions.get(hash)).toEqual(original);
    expect(sessionNeedsRenewal(original, now)).toBe(true);
  });
});
