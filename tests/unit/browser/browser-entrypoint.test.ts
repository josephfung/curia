// tests/unit/browser/browser-entrypoint.test.ts — the browser container launches Chrome
// with the flags Patchright uses when it launches Chromium itself (#2541).
//
// docker/browser-entrypoint.sh copies them because the container has no Node to ask
// Patchright. A Patchright bump that changes them fails this test, so the copy is
// updated alongside (Patchright bumps are held for human review anyway).

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const repoRoot = join(import.meta.dirname, '../../..');
const entrypoint = readFileSync(join(repoRoot, 'docker/browser-entrypoint.sh'), 'utf8');

// patchright-core is patchright's dependency, not ours: resolve it from patchright.
const patchrightDir = realpathSync(join(repoRoot, 'node_modules/patchright'));
const coreDir = dirname(createRequire(join(patchrightDir, 'package.json')).resolve('patchright-core/package.json'));
const bundle = readFileSync(join(coreDir, 'lib/coreBundle.js'), 'utf8');

/** The source text between `start` and the next `end`. */
function slice(start: string, end: string): string {
  const from = bundle.indexOf(start);
  expect(from, `"${start}" not found in patchright-core — has the bundle layout changed?`).toBeGreaterThan(-1);
  return bundle.slice(from, bundle.indexOf(end, from));
}

/** Every string literal in a slice of the bundle. */
function literals(source: string): string[] {
  return [...source.matchAll(/"([^"\n]*)"/g)].map(m => m[1]!);
}

describe('browser-entrypoint.sh Chrome flags', () => {
  it('passes every switch Patchright passes', () => {
    const switches = literals(slice('chromiumSwitches = (options) => [', '].filter(Boolean)'))
      .filter(s => s.startsWith('--'))
      // Built from disabledFeatures (checked below) and from two conditional values.
      .filter(s => !['--disable-features=', '--enable-features=CDPScreenshotNewSurface', '--disable-sync'].includes(s));
    expect(switches.length).toBeGreaterThan(10);
    for (const s of switches) expect(entrypoint, s).toContain(` ${s} \\`);
    expect(entrypoint).toContain(' --enable-features=CDPScreenshotNewSurface \\');
    expect(entrypoint).toContain(' --disable-sync \\');
  });

  it('disables the features Patchright disables', () => {
    const features = literals(slice('disabledFeatures = [', '].filter('))
      // Patchright filters MediaRouter back out of its own list.
      .filter(f => f !== 'MediaRouter');
    const flag = /--disable-features=(\S+) \\/.exec(entrypoint);
    expect(flag).not.toBeNull();
    expect(flag![1]!.split(',').sort()).toEqual([...new Set(features)].sort());
  });

  it('never turns the sandbox off', () => {
    expect(entrypoint).not.toMatch(/--no-sandbox|--disable-setuid-sandbox|--no-zygote/);
  });
});

describe('browser-entrypoint.sh DevTools peer gate', () => {
  // A container on 172.20.0.0/16, the network's gateway (the Docker host's side) at .1.
  const routeFile = join(mkdtempSync(join(tmpdir(), 'curia-route-')), 'route');
  writeFileSync(routeFile, [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t00000000\t010014AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    'eth0\t000014AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
  ].join('\n') + '\n');

  const allowed = (peer: string): boolean =>
    spawnSync('bash', [join(repoRoot, 'docker/browser-entrypoint.sh'), '--devtools-peer-allowed', peer], {
      env: { ...process.env, ROUTE_FILE: routeFile },
    }).status === 0;

  it('lets in a peer on the container’s own network (Curia)', () => {
    expect(allowed('172.20.0.3')).toBe(true);
    expect(allowed('172.20.8.9')).toBe(true);
  });

  it('lets in loopback: the container’s own healthcheck', () => {
    expect(allowed('127.0.0.1')).toBe(true);
  });

  it('refuses the gateway, which is how the Docker host itself arrives', () => {
    expect(allowed('172.20.0.1')).toBe(false);
  });

  it('refuses a peer outside the subnet, e.g. a routed LAN client', () => {
    expect(allowed('192.168.1.20')).toBe(false);
    expect(allowed('172.21.0.3')).toBe(false);
  });

  it('refuses anything that is not an IPv4 address', () => {
    expect(allowed('')).toBe(false);
    expect(allowed('::1')).toBe(false);
    expect(allowed('172.20.0.3; true')).toBe(false);
  });
});
