import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebPushService, vapidSubject, type PushSender, type WebThreadWriter } from '../../../../src/channels/web/push-service.js';
import { HIDDEN_PREVIEW, classifyPushStatus, pushPreview } from '../../../../src/channels/web/push-preview.js';
import type { Logger } from '../../../../src/logger.js';
import type { WebThreadQueryable } from '../../../../src/channels/http/web-thread.js';

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger;

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth_secret: string;
  consecutive_failures: number;
  device_name?: string;
  /** The owning session has expired; the service's queries must skip the row. */
  expired?: boolean;
}

function createPool(state: {
  hide: boolean;
  subs: SubRow[];
  notices: string[];
  failDelete?: boolean;
  failRead?: boolean;
}): WebThreadQueryable {
  return {
    async query(sql: string, params?: unknown[]) {
      if (state.failRead && (sql.includes('hide_previews') || sql.includes('ps.endpoint'))) {
        throw new Error('db down');
      }
      if (state.failDelete && sql.includes('DELETE FROM push_subscriptions')) {
        throw new Error('delete failed');
      }
      if (sql.includes('SELECT conversation_id FROM web_thread')) {
        return { rows: [{ conversation_id: 'conv-1' }] };
      }
      // Both reads must join the owning session and skip an expired one.
      const live = () => {
        if (!sql.includes('JOIN sessions') || !sql.includes('expires_at > NOW()')) {
          throw new Error(`subscription read does not skip expired sessions: ${sql}`);
        }
        return state.subs.filter((row) => !row.expired);
      };
      if (sql.includes('SELECT EXISTS')) {
        return { rows: [{ live: live().length > 0 }] };
      }
      if (sql.includes('SELECT hide_previews')) return { rows: [{ hide_previews: state.hide }] };
      if (sql.includes('ps.endpoint')) return { rows: live().map((row) => ({ ...row })) };
      if (sql.includes('DELETE FROM push_subscriptions')) {
        const ids = params?.[0] as string[];
        state.subs = state.subs.filter((row) => !ids.includes(row.id));
        return { rows: [] };
      }
      if (sql.includes('last_success_at')) return { rows: [] };
      if (sql.includes('consecutive_failures = consecutive_failures + 1')) {
        const id = String(params?.[0]);
        const row = state.subs.find((item) => item.id === id);
        if (!row) return { rows: [] };
        row.consecutive_failures += 1;
        return { rows: [{ consecutive_failures: row.consecutive_failures }] };
      }
      if (sql.includes('SELECT id FROM push_notices')) return { rows: [] };
      if (sql.includes('INSERT INTO push_notices')) {
        state.notices.push(`${String(params?.[0])}:${String(params?.[1])}`);
        return { rows: [] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

function sub(id = 'sub-1'): SubRow {
  return { id, endpoint: `https://push.example/${id}`, p256dh: 'p256', auth_secret: 'auth', consecutive_failures: 0 };
}

function fail(statusCode: number, extra: { body?: string; retryAfterMs?: number } = {}): Error {
  return Object.assign(new Error(`status ${statusCode}`), { statusCode, ...extra });
}

function memory(): WebThreadWriter & { calls: Array<{ conversationId: string; content: string; channelId?: string }> } {
  const calls: Array<{ conversationId: string; content: string; channelId?: string }> = [];
  return {
    calls,
    async addTurn(conversationId, _agentId, turn, meta) {
      calls.push({ conversationId, content: turn.content, channelId: meta?.channelId });
    },
  };
}

function service(opts: {
  pool: WebThreadQueryable;
  sender: PushSender;
  watching?: boolean;
  sleep?: (ms: number) => Promise<void>;
  thread?: WebThreadWriter;
}): WebPushService {
  return new WebPushService({
    pool: opts.pool,
    sender: opts.sender,
    logger,
    configured: true,
    publicKey: 'pub',
    memory: opts.thread ?? memory(),
    isWatching: () => opts.watching ?? false,
    sleep: opts.sleep ?? (async () => undefined),
  });
}

describe('push preview', () => {
  it('strips markdown, keeps emoji whole, and cuts on a word', () => {
    expect(pushPreview('  hello   board  ', false)).toBe('hello board');
    expect(pushPreview('**Board** moved', false)).toBe('Board moved');
    expect(pushPreview('Rename file_name_v2 to 5 * 3 * 2', false)).toBe('Rename file_name_v2 to 5 * 3 * 2');
    expect(pushPreview('[notes](https://example.com) today', false)).toBe('notes today');
    expect(pushPreview('x'.repeat(100), false)).toHaveLength(100);
    const long = `${'word '.repeat(40)}tail`;
    const preview = pushPreview(long, false);
    expect(Array.from(preview).length).toBeLessThanOrEqual(100);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.endsWith(' …')).toBe(false);
    const emoji = `${'a'.repeat(98)}👍`;
    expect(pushPreview(emoji, false)).toBe(`${'a'.repeat(98)}👍`);
    expect(pushPreview('secret plan', true)).toBe(HIDDEN_PREVIEW);
    expect(pushPreview('   ', false)).toBe(HIDDEN_PREVIEW);
  });

  it('strips images and italics', () => {
    expect(pushPreview('see ![chart](https://example.com/c.png) here', false)).toBe('see here');
    expect(pushPreview('an *important* and _quiet_ note', false)).toBe('an important and quiet note');
    expect(pushPreview('Plan:\n\n  - draft\n  2. send', false)).toBe('Plan: draft send');
  });

  it('strips images and links with escaped brackets or IPv6 hosts', () => {
    expect(pushPreview('x ![see \\[note](https://example.com/i.png) y', false)).toBe('x y');
    expect(pushPreview('x ![i](http://[::1]:8080/i.png) y', false)).toBe('x y');
    expect(pushPreview('read [the \\[doc\\]](https://example.com) now', false)).toBe('read the [doc] now');
    expect(pushPreview('open [site](https://[2001:db8::1]/a) now', false)).toBe('open site now');
  });

  it.each([
    ['unclosed image openers', '!['],
    ['unclosed link openers', '['],
    ['unclosed image destinations', '![a]('],
    ['unclosed link destinations', '[a]('],
    ['host-like link destinations', '[a:]('],
    ['host-like image destinations', '![a:]('],
    ['escaped brackets', '[\\['],
    ['escaped bracket run', '\\['],
    ['unclosed * italics', ' *a'],
    ['unclosed _ italics', ' _a'],
    ['blank lines', '\n'],
    ['whitespace-only lines', ' \n'],
  ])('strips a long run of %s in linear time', (_name, unit) => {
    const started = performance.now();
    pushPreview(`[notes](https://example.com) ${unit.repeat(50_000)}`, false);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(pushPreview(`${unit.repeat(50)} [notes](https://example.com)`, false)).not.toContain('example.com');
  });

  it('does not retry a local failure, and retries only 429 and 5xx', () => {
    expect(classifyPushStatus(201)).toBe('ok');
    expect(classifyPushStatus(404)).toBe('gone');
    expect(classifyPushStatus(410)).toBe('gone');
    expect(classifyPushStatus(403)).toBe('setup');
    expect(classifyPushStatus(429)).toBe('retry');
    expect(classifyPushStatus(503)).toBe('retry');
    expect(classifyPushStatus(0)).toBe('failed');
  });

  it('accepts only an https origin as the VAPID subject and logs a bad URL', () => {
    expect(vapidSubject('https://curia.example.com')).toBe('https://curia.example.com');
    expect(vapidSubject('https://curia.example.com/app')).toBe('https://curia.example.com');
    expect(vapidSubject('http://curia.example.com')).toBeNull();
    expect(vapidSubject(undefined)).toBeNull();
    const warn = vi.fn();
    expect(vapidSubject('https://[', { warn })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('WebPushService', () => {
  it('writes the thread and does not push when a browser is watching', async () => {
    const state = { hide: false, subs: [sub()], notices: [] };
    const sender: PushSender = { send: vi.fn() };
    const thread = memory();
    const broadcast = vi.fn();
    const push = service({ pool: createPool(state), sender, watching: true, thread });
    push.setBroadcast(broadcast);
    await expect(push.deliver('The board moved.')).resolves.toEqual({ outcome: 'visible' });
    expect(sender.send).not.toHaveBeenCalled();
    expect(thread.calls).toEqual([{ conversationId: 'conv-1', content: 'The board moved.', channelId: 'web' }]);
    expect(broadcast).toHaveBeenCalledWith('conv-1', expect.objectContaining({
      type: 'message',
      conversation_id: 'conv-1',
      content: 'The board moved.',
    }));
  });

  it('reports a failure, without broadcasting, when an accepted push cannot be saved on the thread', async () => {
    const state = { hide: false, subs: [sub()], notices: [] };
    const sender: PushSender = { send: vi.fn().mockResolvedValue(undefined) };
    const thread: WebThreadWriter = { addTurn: vi.fn().mockRejectedValue(new Error('db down')) };
    const broadcast = vi.fn();
    const push = service({ pool: createPool(state), sender, thread });
    push.setBroadcast(broadcast);
    await expect(push.deliver('The board moved.')).resolves.toEqual({
      outcome: 'unavailable',
      detail: 'The phone was notified, but the message could not be saved on the shared thread.',
    });
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not write the thread when the only subscription is gone', async () => {
    const state = { hide: false, subs: [sub()], notices: [] };
    const sender: PushSender = { send: vi.fn().mockRejectedValue(fail(410)) };
    const thread = memory();
    const push = service({ pool: createPool(state), sender, thread });
    const result = await push.deliver('hello');
    expect(result.outcome).toBe('fallback');
    expect(state.subs).toEqual([]);
    expect(state.notices[0]).toMatch(/^dead:The phone stopped receiving notifications/);
    expect(thread.calls).toEqual([]);
    await expect(push.reachableNow()).resolves.toBe(false);
  });

  it('keeps a rejected subscription, records the body, and still records it when another device delivered', async () => {
    const state = { hide: false, subs: [sub('ok'), sub('bad')], notices: [] };
    const sender: PushSender = {
      send: vi.fn(async (row: { id: string }) => {
        if (row.id === 'bad') throw fail(403, { body: 'BadJwtToken' });
      }),
    };
    const push = service({ pool: createPool(state), sender });
    const result = await push.deliver('hello');
    expect(result).toEqual({ outcome: 'delivered' });
    expect(state.subs.map((row) => row.id)).toEqual(['ok', 'bad']);
    expect(state.notices[0]).toMatch(/setup:Push setup was rejected \(403\): status 403 BadJwtToken/);
  });

  it('logs only the push host, never the full endpoint, when a push is rejected', async () => {
    const state = { hide: false, subs: [sub('setup'), sub('down')], notices: [] };
    const sender: PushSender = {
      send: vi.fn(async (row: { id: string }) => {
        throw row.id === 'setup' ? fail(403, { body: 'BadJwtToken' }) : fail(400);
      }),
    };
    const error = vi.mocked(logger.error);
    error.mockClear();
    await service({ pool: createPool(state), sender }).deliver('hello');
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('"endpointHost":"push.example"');
    expect(logged).not.toContain('https://push.example/');
  });

  it('retries a 5xx twice before falling back, and a third success does not fall back', async () => {
    const state = { hide: false, subs: [sub()], notices: [] };
    let calls = 0;
    const sender: PushSender = {
      send: vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw fail(503);
      }),
    };
    const sleep = vi.fn(async (_ms: number) => undefined);
    const thread = memory();
    const push = service({ pool: createPool(state), sender, sleep, thread });
    await expect(push.deliver('hello')).resolves.toEqual({ outcome: 'delivered' });
    expect(sender.send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const waits = sleep.mock.calls.map((call) => call[0]);
    expect(waits[0]).toBeGreaterThanOrEqual(900);
    expect(waits[0]).toBeLessThanOrEqual(1_100);
    expect(waits[1]).toBeGreaterThanOrEqual(1_900);
    expect(waits[1]).toBeLessThanOrEqual(2_100);
    expect(thread.calls).toHaveLength(1);
  });

  it('does not promise a later retry after the short backoff is spent', async () => {
    const state = { hide: false, subs: [sub()], notices: [] };
    const sender: PushSender = { send: vi.fn().mockRejectedValue(fail(429)) };
    const sleep = vi.fn(async () => undefined);
    const thread = memory();
    const push = service({ pool: createPool(state), sender, sleep, thread });
    const result = await push.deliver('hello');
    expect(result).toMatchObject({ outcome: 'fallback' });
    if (result.outcome === 'fallback') expect(result.detail).not.toMatch(/retried/);
    expect(sender.send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(thread.calls).toEqual([]);
  });

  it('retries once after Retry-After and delivers', async () => {
    const state = { hide: false, subs: [sub()], notices: [] };
    let calls = 0;
    const sender: PushSender = {
      send: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw fail(429, { retryAfterMs: 2000 });
      }),
    };
    const sleep = vi.fn(async () => undefined);
    const thread = memory();
    const push = service({ pool: createPool(state), sender, sleep, thread });
    await expect(push.deliver('hello')).resolves.toEqual({ outcome: 'delivered' });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(thread.calls).toHaveLength(1);
  });

  it('does not fall back or record a notice when nobody has subscribed', async () => {
    const state = { hide: false, subs: [], notices: [] };
    const sender: PushSender = { send: vi.fn() };
    const thread = memory();
    const push = service({ pool: createPool(state), sender, thread });
    await expect(push.deliver('hello')).resolves.toEqual({
      outcome: 'unavailable',
      detail: 'No phone is subscribed to notifications.',
    });
    expect(state.notices).toEqual([]);
    expect(thread.calls).toEqual([]);
  });

  it('hides the preview when the setting is on', async () => {
    const state = { hide: true, subs: [sub()], notices: [] };
    const sender: PushSender = { send: vi.fn().mockResolvedValue(undefined) };
    const push = service({ pool: createPool(state), sender });
    await expect(push.deliver('secret board plan')).resolves.toEqual({ outcome: 'delivered' });
    const body = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(body).toContain(HIDDEN_PREVIEW);
    expect(body).not.toContain('secret');
    expect(body).toContain('"tag":"curia-conv-1"');
  });

  it('keeps the row after six setup rejections', async () => {
    const state = { hide: false, subs: [sub()], notices: [] as string[] };
    const sender: PushSender = { send: vi.fn().mockRejectedValue(fail(403, { body: 'BadJwtToken' })) };
    const push = service({ pool: createPool(state), sender, sleep: async () => undefined });
    for (let i = 0; i < 6; i += 1) {
      await push.deliver('hello');
    }
    expect(state.subs).toHaveLength(1);
    expect(state.subs[0]?.consecutive_failures).toBe(0);
    expect(state.notices.every((notice) => notice.startsWith('setup:'))).toBe(true);
  });

  it('records a named dead notice when one device is gone and another accepts', async () => {
    const state = {
      hide: false,
      subs: [{ ...sub('ok'), device_name: 'Android' }, { ...sub('gone'), device_name: 'iPhone' }],
      notices: [] as string[],
    };
    const sender: PushSender = {
      send: vi.fn(async (row: { id: string }) => {
        if (row.id === 'gone') throw fail(410);
      }),
    };
    const push = service({ pool: createPool(state), sender });
    await expect(push.deliver('hello')).resolves.toEqual({ outcome: 'delivered' });
    expect(state.subs.map((row) => row.id)).toEqual(['ok']);
    expect(state.notices[0]).toMatch(/dead:Your iPhone stopped receiving notifications/);
  });

  it('returns unavailable when the subscription read fails, and stays delivered when cleanup fails', async () => {
    const unread = { hide: false, subs: [sub()], notices: [], failRead: true };
    const blocked = service({ pool: createPool(unread), sender: { send: vi.fn() } });
    await expect(blocked.deliver('hello')).resolves.toEqual({
      outcome: 'unavailable',
      detail: 'Notifications are temporarily unavailable.',
    });

    const state = {
      hide: false,
      subs: [sub('ok'), sub('gone')],
      notices: [] as string[],
      failDelete: true,
    };
    const sender: PushSender = {
      send: vi.fn(async (row: { id: string }) => {
        if (row.id === 'gone') throw fail(410);
      }),
    };
    const push = service({ pool: createPool(state), sender });
    await expect(push.deliver('hello')).resolves.toEqual({ outcome: 'delivered' });
  });

  it('does not announce an empty subscription list for a chat reply', async () => {
    const state = { hide: false, subs: [], notices: [] };
    const sender: PushSender = { send: vi.fn() };
    const push = service({ pool: createPool(state), sender });
    await push.notifyReply('already on the thread', 'conv-1');
    expect(sender.send).not.toHaveBeenCalled();
    expect(state.notices).toEqual([]);
  });

  it('neither counts nor sends to a subscription whose session has expired', async () => {
    const state = { hide: false, subs: [{ ...sub('stale'), expired: true }] as SubRow[], notices: [] as string[] };
    const sender: PushSender = { send: vi.fn().mockResolvedValue(undefined) };
    const push = service({ pool: createPool(state), sender });
    await expect(push.reachableNow()).resolves.toBe(false);
    await expect(push.deliver('hello')).resolves.toEqual({
      outcome: 'unavailable',
      detail: 'No phone is subscribed to notifications.',
    });
    expect(sender.send).not.toHaveBeenCalled();

    state.subs.push(sub('live'));
    await expect(push.reachableNow()).resolves.toBe(true);
    await expect(push.deliver('hello')).resolves.toEqual({ outcome: 'delivered' });
    expect((sender.send as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { id: string }).id)).toEqual(['live']);
  });

  it('reads reachability from the table, not a remembered flag', async () => {
    const state = { hide: false, subs: [sub()], notices: [] };
    const push = service({ pool: createPool(state), sender: { send: vi.fn() } });
    await expect(push.reachableNow()).resolves.toBe(true);
    state.subs = [];
    await expect(push.reachableNow()).resolves.toBe(false);
  });

  describe('push phase wall time', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    it('shrinks each attempt to the time left, so slow 5xx answers still fall back inside twelve seconds', async () => {
      const state = { hide: false, subs: [sub()], notices: [] as string[] };
      const timeouts: number[] = [];
      // Each attempt answers 503 only when its timeout is nearly spent.
      const sender: PushSender = {
        send: vi.fn((_row, _body, options: { timeoutMs: number }) => {
          timeouts.push(options.timeoutMs);
          return new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(fail(503)), Math.max(0, options.timeoutMs - 50));
          });
        }),
      };
      const push = service({ pool: createPool(state), sender, sleep: realSleep });
      const started = Date.now();
      let finishedAt = 0;
      const pending = push.deliver('hello').then((result) => {
        finishedAt = Date.now();
        return result;
      });
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(result).toMatchObject({ outcome: 'fallback' });
      // Without the shrink this took 10s + ~1s + 10s + ~2s + 10s.
      expect(finishedAt - started).toBeLessThanOrEqual(12_000);
      expect(timeouts[0]).toBe(10_000);
      // The retry got only what was left of the phase, not another ten seconds.
      expect(timeouts.length).toBeGreaterThanOrEqual(2);
      for (const timeout of timeouts.slice(1)) expect(timeout).toBeLessThan(10_000);
    });

    it('gives up on an attempt that never answers at its deadline', async () => {
      const state = { hide: false, subs: [sub()], notices: [] as string[] };
      const sender: PushSender = { send: vi.fn(() => new Promise<void>(() => undefined)) };
      const push = service({ pool: createPool(state), sender, sleep: realSleep });
      const started = Date.now();
      let finishedAt = 0;
      const pending = push.deliver('hello').then((result) => {
        finishedAt = Date.now();
        return result;
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toMatchObject({ outcome: 'fallback' });
      // A local failure is not retried, so the phase ends at the first deadline.
      expect(finishedAt - started).toBe(10_000);
      expect(sender.send).toHaveBeenCalledTimes(1);
    });
  });
});
