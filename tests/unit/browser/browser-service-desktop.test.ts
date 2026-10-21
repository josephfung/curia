// tests/unit/browser/browser-service-desktop.test.ts — the window manager + panel that
// BrowserService runs on its Xvfb display (#2221). spawn is mocked, so no X server or
// desktop binaries are needed; kept apart from browser-service.test.ts so that file's
// real-browser tests keep the real child_process.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn,
}));

import { BrowserService } from '../../../src/browser/browser-service.js';

class FakeProcess extends EventEmitter {
  kill = vi.fn();
}

// startDesktopSession is private; reach it through a structural cast.
type DesktopSession = { startDesktopSession(): Promise<void> };

// BrowserService logs through a child logger, so replace warn on that child directly.
function makeService() {
  const svc = new BrowserService({ logger: pino({ level: 'silent' }), contextFactory: async () => { throw new Error('unused'); } });
  const warn = vi.fn();
  (svc as unknown as { logger: { warn: typeof warn } }).logger.warn = warn;
  return { svc, warn };
}

describe('BrowserService desktop session (#2221)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawn.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts openbox, then tint2, and kills both on stop()', async () => {
    const procs: FakeProcess[] = [];
    spawn.mockImplementation(() => {
      const p = new FakeProcess();
      procs.push(p);
      return p;
    });
    const { svc } = makeService();

    const started = (svc as unknown as DesktopSession).startDesktopSession();
    await vi.advanceTimersByTimeAsync(1000);
    await started;

    expect(spawn.mock.calls.map(c => [c[0], c[1]])).toEqual([['openbox', ['--sm-disable']], ['tint2', []]]);
    await svc.stop();
    expect(procs.map(p => p.kill.mock.calls.length)).toEqual([1, 1]);
  });

  it('warns and skips the panel when the window manager is missing', async () => {
    spawn.mockImplementation(() => {
      const p = new FakeProcess();
      queueMicrotask(() => p.emit('error', Object.assign(new Error('spawn openbox ENOENT'), { code: 'ENOENT' })));
      return p;
    });
    const { svc, warn } = makeService();

    const started = (svc as unknown as DesktopSession).startDesktopSession();
    await vi.advanceTimersByTimeAsync(1000);
    await started;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'openbox', reason: 'spawn openbox ENOENT' }),
      expect.stringContaining('headless fingerprint tell'),
    );
  });

  it('warns when a program exits during startup', async () => {
    spawn.mockImplementation(() => {
      const p = new FakeProcess();
      queueMicrotask(() => p.emit('close', 1));
      return p;
    });
    const { svc, warn } = makeService();

    const started = (svc as unknown as DesktopSession).startDesktopSession();
    await vi.advanceTimersByTimeAsync(1000);
    await started;

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatchObject({ reason: 'exited during startup (code 1)' });
  });
});
