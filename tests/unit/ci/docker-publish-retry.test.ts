/**
 * docker-publish retries a transient SBOM-scanner pull without retrying a
 * broken build (curia#1864).
 *
 * The behaviour itself is pinned by tests/docker/test-buildx-retry.sh, which
 * forces the failure. This file pins the wiring: the retry stays inside the
 * build step (so a recovered attempt is a green job and notify-failure stays
 * quiet), the job wall stays 60 minutes, and both images still request an SBOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = join(import.meta.dirname, '../../..');

interface BuildStep {
  id?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: boolean;
}

interface Job {
  'timeout-minutes': number;
  permissions: Record<string, string>;
  steps: BuildStep[];
}

interface Workflow {
  jobs: {
    'build-arch': Job;
    build: Job;
    'notify-failure': {
      if: string;
      needs: string[];
    };
  };
}

const workflow = yaml.load(
  readFileSync(join(ROOT, '.github/workflows/docker-publish.yml'), 'utf8'),
) as Workflow;

describe('docker-publish retry wiring (#1864)', () => {
  // build-arch builds and pushes each platform; build assembles them under the tags and signs.
  const arch = workflow.jobs['build-arch'];
  const build = workflow.jobs.build;
  const archStep = arch.steps.find((candidate) => candidate.id === 'build');
  const step = build.steps.find((candidate) => candidate.id === 'build');

  it('retries inside the build and assemble steps, so a recovered attempt stays a success', () => {
    expect(archStep?.run).toBe('bash "$RUNNER_TEMP/publish-tools/docker/publish-image.sh"');
    expect(step?.run).toBe('bash "$RUNNER_TEMP/publish-tools/docker/assemble-image.sh"');
    for (const s of [archStep, step]) {
      expect(s?.['continue-on-error']).toBeUndefined();
      expect(s?.if ?? '').not.toMatch(/always\s*\(/);
    }
    expect(readFileSync(join(ROOT, 'docker/assemble-image.sh'), 'utf8')).toContain('buildx-retry.sh');
  });

  it('keeps the 60 minute wall, and only the building legs write the Actions cache', () => {
    expect(arch['timeout-minutes']).toBe(60);
    expect(arch.permissions).toEqual({ contents: 'read', packages: 'write', actions: 'write' });
    expect(build['timeout-minutes']).toBe(60);
    expect(build.permissions).toEqual({ contents: 'read', packages: 'write', 'id-token': 'write' });
  });

  it('still requests an SBOM and max provenance, scoped per image', () => {
    const script = readFileSync(join(ROOT, 'docker/publish-image.sh'), 'utf8');
    expect(script).toContain('type=sbom');
    expect(script).toContain('type=provenance,mode=max');
    expect(script).toContain('type=gha,mode=max,scope=${CACHE_SCOPE},ignore-error=true');
    expect(script).toContain('buildx-retry.sh');
  });

  it('alerts only when the build job failed', () => {
    const notify = workflow.jobs['notify-failure'];
    expect(notify.if).toBe("always() && needs.build.result == 'failure'");
    expect(notify.needs).toEqual(['resolve', 'build']);
  });

  // #2369: a Rekor 409 after a timed-out upload failed the publish twice in one
  // day. The retry must stay inside the sign step for the same reason as above.
  it('signs through the retrying script, inside the step', () => {
    const sign = build.steps.find((candidate) => candidate.run?.includes('sign-image.sh'));
    expect(sign?.run).toBe('bash "$RUNNER_TEMP/publish-tools/docker/sign-image.sh"');
    expect(sign?.['continue-on-error']).toBeUndefined();
    expect(build.steps.some((candidate) => /^\s*cosign sign\b/m.test(candidate.run ?? ''))).toBe(false);
    const script = readFileSync(join(ROOT, 'docker/sign-image.sh'), 'utf8');
    expect(script).toContain('SIGN_RETRY_ATTEMPTS:-3');
    expect(script).toContain('cosign sign --yes "${IMAGE}@${DIGEST}"');
  });

  it('caps the outer retry at three attempts and refuses an unclassified failure', () => {
    const retry = readFileSync(join(ROOT, 'docker/buildx-retry.sh'), 'utf8');
    expect(retry).toContain('BUILDX_RETRY_ATTEMPTS:-3');
    expect(retry).toContain('not retrying');
  });
});
