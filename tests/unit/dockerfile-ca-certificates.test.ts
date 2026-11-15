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
// bundle exists, so a regression fails `docker build` instead of a production call.
// No CI job builds the image on a PR, though: the first build is after merge
// (trivy-image on push to main, docker-publish). This test is the PR-time guard.

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

/**
 * Package names passed to each `apt-get install` in a RUN, as whole tokens.
 * Matching the RUN text instead would be fooled by the bundle path
 * `/etc/ssl/certs/ca-certificates.crt` in the same chain.
 */
function aptInstallPackages(run: string): string[] {
  const packages: string[] = [];
  for (const command of run.split(/&&|;|\|\|/)) {
    const match = /\bapt-get\b.*?\binstall\b(.*)$/.exec(command);
    if (!match) continue;
    packages.push(...match[1]!.trim().split(/\s+/).filter((arg) => arg && !arg.startsWith('-')));
  }
  return packages;
}

const BUNDLE_CHECK = 'test -s /etc/ssl/certs/ca-certificates.crt';

describe('runtime image CA bundle', () => {
  const runs = runInstructions(runtimeStage(dockerfile));

  it('installs ca-certificates in the runtime stage', () => {
    expect(runs.flatMap(aptInstallPackages)).toContain('ca-certificates');
  });

  it('fails the build when the CA bundle is missing', () => {
    // Chained with && and not softened with || or a trailing ;, so a missing
    // bundle fails the RUN rather than being skipped.
    const check = runs.find((run) => run.includes(BUNDLE_CHECK));
    expect(check, `no RUN in the runtime stage runs \`${BUNDLE_CHECK}\``).toBeDefined();
    expect(check!.replace(/\s+/g, ' ')).toMatch(/&& test -s \/etc\/ssl\/certs\/ca-certificates\.crt\s*$/);
  });

  // Mutation checks on the helpers, so the guards above cannot pass vacuously.
  it('does not mistake the bundle path for the package', () => {
    expect(aptInstallPackages(`apt-get install -y curl && ${BUNDLE_CHECK}`)).toEqual(['curl']);
  });
});
