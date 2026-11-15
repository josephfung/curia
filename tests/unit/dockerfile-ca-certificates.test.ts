// The runtime image must ship the system CA bundle.
//
// Node verifies TLS against its own bundled roots, so HTTPS from JS works without
// one, which is how its absence went unnoticed. Native code does not: the LiveKit
// client (@livekit/rtc-node, Rust FFI) reads the OS trust store, and from FFI
// bindings 0.13 (rtc-node 1.2) it finds nothing in node:26-slim. Every console and
// PWA call then failed to join the room with "no native root CA certificates found"
// while Signal calls, which never touch LiveKit, kept working.
//
// node:26-slim does not include ca-certificates, and `--no-install-recommends`
// stops curl from pulling it in, so it has to be named. The build also asserts the
// bundle exists, so a regression fails `docker build` (CI's Trivy job builds this
// Dockerfile on every PR) instead of a production call.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(join(import.meta.dirname, '../../Dockerfile'), 'utf8');

/** Everything from the last FROM: the stage that becomes the published image. */
function runtimeStage(text: string): string {
  const starts = [...text.matchAll(/^FROM\s/gm)].map((m) => m.index ?? 0);
  expect(starts.length, 'Dockerfile has no FROM').toBeGreaterThan(0);
  return text.slice(starts[starts.length - 1]);
}

/** RUN instructions with their backslash continuations joined into one line each. */
function runInstructions(stage: string): string[] {
  return stage
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((line) => /^RUN\s/.test(line));
}

describe('runtime image CA bundle', () => {
  const runs = runInstructions(runtimeStage(dockerfile));

  it('installs ca-certificates in the runtime stage', () => {
    const installs = runs.filter((run) => /apt-get\b.*\binstall\b/.test(run));
    expect(installs.some((run) => /\bca-certificates\b/.test(run))).toBe(true);
  });

  it('fails the build when the CA bundle is missing', () => {
    expect(runs.some((run) => /test\s+-s\s+\/etc\/ssl\/certs\/ca-certificates\.crt/.test(run))).toBe(true);
  });
});
