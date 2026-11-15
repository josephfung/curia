// The runtime image must ship the system CA bundle. Node's HTTPS uses its own
// bundled roots, but the LiveKit client (@livekit/rtc-node, Rust FFI) reads the OS
// trust store, and without it every console and PWA call failed to join its room.
// node:26-slim does not include ca-certificates, so the Dockerfile installs it and
// `test -s` fails the build if the bundle is missing. That build only runs after
// merge, so this checks both lines are still there at PR time.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(join(import.meta.dirname, '../../Dockerfile'), 'utf8');

describe('runtime image CA bundle', () => {
  it('installs ca-certificates and fails the build without the bundle', () => {
    expect(dockerfile).toMatch(/apt-get[^\n]*\binstall\b[^\n]*\sca-certificates\s/);
    expect(dockerfile).toMatch(/&& test -s \/etc\/ssl\/certs\/ca-certificates\.crt/);
  });
});
