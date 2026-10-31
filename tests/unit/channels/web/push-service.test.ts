import { describe, expect, it, vi } from 'vitest';
import { WebPushService, vapidSubject, type PushSender } from '../../../../src/channels/web/push-service.js';
import { HIDDEN_PREVIEW, classifyPushStatus, pushPreview, pushRetryDelayMs } from '../../../../src/channels/web/push-preview.js';
import type { Logger } from '../../../../src/logger.js';
import type { WebThreadQueryable } from '../../../../src/channels/http/web-thread.js';

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger;

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth_secret: string;
}

function createPool(state: { hide: boolean; subs: SubRow[]; notices: string[] }): WebThreadQueryable & { notices: string[] } {
  return {
    notices: state.notices,
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('SELECT conversation_id FROM web_thread')) {
        return { rows: [{ conversation_id: 'conv-1' }] };
      }
      if (sql.includes('INSERT INTO working_memory')) return { rows: [] };
      if (sql.includes('SELECT hide_previews')) return { rows: [{ hide_previews: state.hide }] };
      if (sql.includes('SELECT id, endpoint')) return { rows: state.subs.map((row) => ({ ...row })) };
      if (sql.includes('DELETE FROM push_subscriptions')) {
        const ids = params?.[0] as string[];
        state.subs = state.subs.filter((row) => !ids.includes(row.id));
        return { rows: [] };
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
  return { id, endpoint: `https://push.example/${id}`, p256dh: 'p256', auth_secret: 'auth' };
}

function fail(statusCode: number): Error {
  return Object.assign(new Error(`status ${statusCode}`), { statusCode });
}

function service(opts: {
  pool: WebThreadQueryable;
  sender: PushSender;
  watching?: boolean;
  sleep?: (ms: number) => Promise<void>;
}): WebPushService {
  return new WebPushService({
    pool: opts.pool,
    sender: opts.sender,
    logger,
    configured: true,
    publicKey: 'pub',
    isWatching: () => opts.watching ?? false,
    sleep: opts.sleep ?? (async () => undefined),
  });
}

describe('push preview', () => {
  it('caps a preview at 100 characters and hides it when asked', () => {
    expect(pushPreview('  hello   board  ', false)).toBe('hello board');
    expect(pushPreview('x'.repeat(100), false)).toHaveLength(100);
    expect(pushPreview('x'.repeat(140), false)).toHaveLength(100);
    expect(pushPreview('x'.repeat(140), false).endsWith('…')).toBe(true);
    expect(pushPreview('secret plan', true)).toBe(HIDDEN_PREVIEW);
    expect(pushPreview('   ', false)).toBe(HIDDEN_PREVIEW);
  });

  it('classifies push statuses and spaces retries at 1s, 2s, 4s', () => {
    expect(classifyPushStatus(201)).toBe('ok');
    expect(classifyPushStatus(404)).toBe('gone');
    expect(classifyPushStatus(410)).toBe('gone');
    expect(classifyPushStatus(403)).toBe('setup');
    expect(classifyPushStatus(429)).toBe('retry');
    expect(classifyPushStatus(503)).toBe('retry');
    expect(pushRetryDelayMs(0)).toBe(1000);
    expect(pushRetryDelayMs(1)).toBe(2000);
    expect(pushRetryDelayMs(2)).toBe(4000);
  });

  it('accepts only an https origin as the VAPID subject', () => {
    expect(vapidSubject('https://curia.example.com')).toBe('https://curia.example.com');
    expect(vapidSubject('https://curia.example.com/app')).toBe('https://curia.example.com');
    expect(vapidSubject('http://curia.example.com')).toBeNull();
    expect(vapidSubject(undefined)).toBeNull();
  });
});

describe('WebPushService', () => {
  it('does not push when a browser already has the thread open', async () => {
    const state = { hide: false, subs: [sub()], notices: [] };
    const sender: PushSender = { send: vi.fn() };
    const broadcast = vi.fn();
    const push = service({ pool: createPool(state), sender, watching: true });
    push.setBroadcast(broadcast);
    await expect(push.deliver('The board moved.')).resolves.toEqual({ outcome: 'visible' });
    expect(sender.send).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith('conv-1', expect.objectContaining({ content: 'The board moved.' }));
  });

  it('deletes a gone subscription and falls back when none remain', async () => {
    const state = { hide: false, subs: [sub()], notices: [] };
    const sender: PushSender = { send: vi.fn().mockRejectedValue(fail(410)) };
    const push = service({ pool: createPool(state), sender });
    const result = await push.deliver('hello');
    expect(result.outcome).toBe('fallback');
    expect(state.subs).toEqual([]);
    expect(state.notices[0]).toMatch(/^dead:/);
    expect(push.reachableNow()).toBe(false);
  });

  it('keeps a subscription the push service rejected and records the reason', async () => {
    const state = { hide: false, subs: [sub()], notices: [] };
    const sender: PushSender = { send: vi.fn().mockRejectedValue(fail(403)) };
    const push = service({ pool: createPool(state), sender });
    const result = await push.deliver('hello');
    expect(result).toMatchObject({ outcome: 'fallback' });
    expect(state.subs).toHaveLength(1);
    expect(state.notices[0]).toMatch(/^setup:Push setup was rejected \(403\)/);
  });

  it('retries a busy push service and does not fall back', async () => {
    const state = { hide: false, subs: [sub()], notices: [] };
    const sender: PushSender = { send: vi.fn().mockRejectedValue(fail(429)) };
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => { delays.push(ms); });
    const push = service({ pool: createPool(state), sender, sleep });
    const result = await push.deliver('hello');
    expect(result.outcome).toBe('unavailable');
    expect(sender.send).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(state.notices).toEqual([]);
    expect(state.subs).toHaveLength(1);
  });

  it('hides the preview when the setting is on', async () => {
    const state = { hide: true, subs: [sub()], notices: [] };
    const sender: PushSender = { send: vi.fn().mockResolvedValue(undefined) };
    const push = service({ pool: createPool(state), sender });
    await expect(push.deliver('secret board plan')).resolves.toEqual({ outcome: 'delivered' });
    const body = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(body).toContain(HIDDEN_PREVIEW);
    expect(body).not.toContain('secret');
  });

  it('does not announce an empty subscription list for a chat reply', async () => {
    const state = { hide: false, subs: [], notices: [] };
    const sender: PushSender = { send: vi.fn() };
    const pool = createPool(state);
    const push = service({ pool, sender });
    await push.notifyReply('already on the thread', 'conv-1');
    expect(sender.send).not.toHaveBeenCalled();
    expect(state.notices).toEqual([]);
  });
});
