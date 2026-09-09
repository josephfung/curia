// Tests for checkSignalVoice — the /api/health probe for the Signal voice audio
// path (curia#1760).
//
// Why this check exists: during curia-deploy#221 the shared PulseAudio socket was
// dead for hours, so Signal voice calls could not work at all, and the console
// dashboard read "All systems nominal" with a green Voice chip. Nothing was lying:
// `signal` probes the JSON-RPC socket (messaging) and `voice` probes LiveKit
// (console/WebRTC voice). No check covered the Signal audio path at all.
//
// These tests use REAL Unix sockets rather than mocks, because the property under
// test is precisely the one a mock would paper over: a stale socket inode with no
// listener behind it must report `fail`. The dead container in #221 held exactly
// that — a socket file at /tmp/pulse-runtime/pulse/native written by a daemon that
// had been gone for a week. `test -S` passes against a corpse; connect() does not.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSignalVoice, SIGNAL_VOICE_PROBE_TIMEOUT_MS } from '../../../src/health/health-checks.js';
import type { Logger } from '../../../src/logger.js';

const stubLogger = { warn: () => {} } as unknown as Logger;

// Unix socket paths are capped near 104 bytes on macOS, so keep the temp dir short.
const dirs: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-'));
  dirs.push(dir);
  return dir;
}

/** A listening Unix socket — stands in for a live PulseAudio daemon. */
async function liveSocket(): Promise<string> {
  const path = join(tempDir(), 'native');
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return path;
}

/**
 * A real socket inode with nothing listening — the #221 shape.
 *
 * Built by listening in a CHILD process and SIGKILLing it. That matters: an
 * in-process `server.close()` unlinks the path, and writing a regular file in its
 * place would fail the probe with ENOTSOCK, which is a different error than the one
 * production hit. SIGKILL runs no cleanup, so the socket inode survives exactly as
 * it did in the dead container — `srwxrwxrwx native`, owner long gone. The assertion
 * below pins that: if this ever stops being a socket, the test is no longer covering
 * the case it claims to.
 */
async function staleSocket(): Promise<string> {
  const path = join(tempDir(), 'native');
  const child = spawn(process.execPath, [
    '-e',
    "require('net').createServer().listen(process.argv[1], () => console.log('ready'))",
    path,
  ]);
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`helper exited early (${code})`)));
  });
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  // The inode must have outlived the process, or this test proves nothing.
  expect(statSync(path).isSocket()).toBe(true);
  return path;
}

afterEach(() => {
  for (const c of children.splice(0)) if (!c.killed) c.kill('SIGKILL');
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('checkSignalVoice', () => {
  it('returns skipped when the Signal voice path is not configured', async () => {
    // No socket path => the call bridge was never constructed. Not a failure:
    // an instance without Signal voice must not show a permanently red chip.
    expect(await checkSignalVoice(undefined, stubLogger)).toBe('skipped');
  });

  it('returns ok when a daemon is listening on the socket', async () => {
    expect(await checkSignalVoice(await liveSocket(), stubLogger)).toBe('ok');
  });

  it('returns fail when the socket path does not exist', async () => {
    // The #221 production shape: /var/run/pulse-shared/ was empty because pulse
    // never started.
    const missing = join(tempDir(), 'native');
    expect(await checkSignalVoice(missing, stubLogger)).toBe('fail');
  });

  it('returns fail for a stale socket inode with no listener', async () => {
    // THE central case. A `test -S`-style existence check passes here and reports
    // a dead audio stack as healthy. Connecting is what tells them apart.
    expect(await checkSignalVoice(await staleSocket(), stubLogger)).toBe('fail');
  });

  it('does not leave the probe connection open', async () => {
    // A liveness endpoint is hit every 30s by the Docker healthcheck. A probe that
    // leaks a socket per call exhausts descriptors — the same shape as the
    // listTools() Ajv leak that OOM-restarted prod (#1663).
    const path = await liveSocket();
    const server = servers[servers.length - 1]!;
    let open = 0;
    server.on('connection', (sock) => { open++; sock.on('close', () => { open--; }); });

    for (let i = 0; i < 5; i++) expect(await checkSignalVoice(path, stubLogger)).toBe('ok');
    await new Promise((r) => setTimeout(r, 50));
    expect(open).toBe(0);
  });

  it('settles quickly instead of hanging', async () => {
    // A liveness endpoint that can block forever is worse than one reporting fail.
    //
    // The timer inside the probe is deliberately NOT asserted directly: a Unix-socket
    // connect resolves or errors in the same tick, so a timeout cannot be triggered
    // deterministically without injecting a fake connector — a seam that would exist
    // only for this test. The timer stays as defence for the case the kernel can
    // still produce (a daemon listening with a saturated backlog). What is worth
    // pinning, and what this asserts, is the contract callers depend on: every
    // outcome settles well inside the probe budget.
    const missing = join(tempDir(), 'native');
    const started = Date.now();
    expect(await checkSignalVoice(missing, stubLogger)).toBe('fail');
    expect(Date.now() - started).toBeLessThan(SIGNAL_VOICE_PROBE_TIMEOUT_MS);
  });
});
