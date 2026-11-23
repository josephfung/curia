// http-adapter-stop.test.ts — stop() clears the prune sweep (#2361) and ends open event
// streams (#2358) before closing Fastify.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpAdapter } from '../../../../src/channels/http/http-adapter.js';

describe('HttpAdapter.stop', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('clears the prune interval before closing the server', async () => {
    const order: string[] = [];
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => { order.push('clearInterval'); });
    const timer = setInterval(() => {}, 60_000);
    timer.unref();
    // stop() reads only these members; start() (which sets the interval) needs the whole app.
    const self = {
      pruneInterval: timer,
      app: { close: vi.fn(async () => { order.push('close'); }) },
      eventRouter: { closeAllStreams: vi.fn(() => { order.push('streams'); return 0; }) },
      config: { logger: { info: vi.fn() } },
    };
    await HttpAdapter.prototype.stop.call(self as unknown as HttpAdapter);
    expect(clear).toHaveBeenCalledWith(timer);
    expect(order).toEqual(['clearInterval', 'streams', 'close']);
    expect(self.pruneInterval).toBeUndefined();
    clear.mockRestore();
    clearInterval(timer);
  });

  it('stops cleanly when start() never ran', async () => {
    const self = {
      pruneInterval: undefined,
      app: { close: vi.fn(async () => {}) },
      eventRouter: { closeAllStreams: vi.fn(() => 0) },
      config: { logger: { info: vi.fn() } },
    };
    await expect(HttpAdapter.prototype.stop.call(self as unknown as HttpAdapter)).resolves.toBeUndefined();
    expect(self.app.close).toHaveBeenCalledOnce();
  });
});
